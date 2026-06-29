// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @title VerdiktEscrow
/// @notice Holds a payer agent's USDC against a task; settles to worker (release),
///         payer (refund), or payer-default (abstain) only on an authorized verdict,
///         anchoring the verdict code + evidence hash on-chain.
contract VerdiktEscrow {
    // Arc testnet USDC predeploy (6 decimals). Fixed — not configurable.
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    uint8 private constant STATUS_EMPTY = 0;
    uint8 private constant STATUS_FUNDED = 1;
    uint8 private constant STATUS_SETTLED = 2;

    uint8 private constant OUTCOME_RELEASE = 0; // -> worker
    uint8 private constant OUTCOME_REFUND = 1; // -> payer
    uint8 private constant OUTCOME_ABSTAIN = 2; // -> payer (default)

    struct Escrow {
        address payer;
        address worker;
        uint256 amount; // USDC, 6 decimals
        uint8 status; // 0 EMPTY, 1 FUNDED, 2 SETTLED
        uint8 outcome; // valid when SETTLED
        uint8 verdictCode; // 0 pass,1 fail,2 partial,3 abstain
        bytes32 evidenceHash; // anchored evidence commitment
    }

    mapping(bytes32 => Escrow) private escrows;

    // Sum of USDC currently backing FUNDED escrows. Lets sweep() recover stray balance without
    // ever touching escrowed principal (free = balanceOf(this) - totalEscrowed).
    uint256 public totalEscrowed;

    address public owner;
    address public verdict; // settlement orchestrator wallet (Circle DCW)
    address public hook; // authorized cross-chain funder (EscrowFundingHook); funds CCTP-minted USDC

    event Funded(bytes32 indexed workId, address payer, address worker, uint256 amount);
    event Settled(
        bytes32 indexed workId,
        uint8 outcome,
        address to,
        uint256 amount,
        uint8 verdictCode,
        bytes32 evidenceHash
    );
    event VerdictUpdated(address indexed oldVerdict, address indexed newVerdict);
    event HookSet(address indexed oldHook, address indexed newHook);

    modifier onlyVerdict() {
        require(msg.sender == verdict, "not verdict");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _verdict) {
        require(_verdict != address(0), "verdict=0");
        owner = msg.sender;
        verdict = _verdict;
    }

    /// @notice Rotate the settlement wallet if the Circle DCW address changes.
    function setVerdict(address _verdict) external onlyOwner {
        require(_verdict != address(0), "verdict=0");
        emit VerdictUpdated(verdict, _verdict);
        verdict = _verdict;
    }

    /// @notice Authorize the cross-chain funding hook (EscrowFundingHook). The hook receives
    ///         CCTP-minted USDC on Arc and calls fundCrossChain. Settable by owner so the hook
    ///         can be deployed after the escrow (it needs the escrow address at construction).
    function setHook(address _hook) external onlyOwner {
        emit HookSet(hook, _hook);
        hook = _hook;
    }

    /// @notice Fund an escrow with USDC that already lives on Arc — used by the cross-chain hook
    ///         after CCTP mints USDC to it. The hook approves this contract for `amount`, then
    ///         calls this; we pull exactly `amount` via transferFrom. Only the authorized hook can
    ///         call (the EIP-3009 path stays the route for native payers). The escrow params
    ///         (workId, payer, worker, amount) come from the Iris-attested CCTP message, so the
    ///         hook cannot fund a task the payer did not commit to.
    /// @dev    Checks-effects-interactions: record the escrow + bump totalEscrowed BEFORE the
    ///         external transferFrom. (USDC has no transfer callback, but CEI removes all doubt.)
    function fundCrossChain(bytes32 workId, address payer, address worker, uint256 amount)
        external
    {
        require(msg.sender == hook, "not hook");
        require(escrows[workId].status == STATUS_EMPTY, "workId exists");
        require(amount > 0, "amount=0");
        require(worker != address(0), "worker=0");
        require(payer != address(0), "payer=0");

        totalEscrowed += amount;
        escrows[workId] = Escrow({
            payer: payer,
            worker: worker,
            amount: amount,
            status: STATUS_FUNDED,
            outcome: 0,
            verdictCode: 0,
            evidenceHash: bytes32(0)
        });

        require(IERC20(USDC).transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        emit Funded(workId, payer, worker, amount);
    }

    /// @notice Payer funds the escrow: pulls `amount` USDC from msg.sender into this
    ///         contract via EIP-3009 and records the escrow atomically.
    /// @dev    `from` of the authorization is forced to msg.sender (the payer), and the
    ///         EIP-3009 `nonce` is DERIVED from (workId, worker, amount, payer). A
    ///         mempool observer who copies the payer's signed blob but changes workId
    ///         or worker computes a different nonce, so the signature no longer recovers
    ///         and the token reverts — the authorization is bound to this exact task.
    ///         We use receiveWithAuthorization (msg.sender == to enforced by the token), so the
    ///         ONLY way to redeem the payer's signature is through this function, which records the
    ///         escrow atomically. That closes the H-1 stranded-funds front-run.
    function fundWithAuthorization(
        bytes32 workId,
        address worker,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external {
        require(escrows[workId].status == STATUS_EMPTY, "workId exists");
        require(amount > 0, "amount=0");
        require(worker != address(0), "worker=0");

        bytes32 nonce = keccak256(abi.encode(workId, worker, amount, msg.sender));
        (uint8 v, bytes32 r, bytes32 s) = _split(sig);
        IERC3009(USDC).receiveWithAuthorization(
            msg.sender, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );

        totalEscrowed += amount;
        escrows[workId] = Escrow({
            payer: msg.sender,
            worker: worker,
            amount: amount,
            status: STATUS_FUNDED,
            outcome: 0,
            verdictCode: 0,
            evidenceHash: bytes32(0)
        });
        emit Funded(workId, msg.sender, worker, amount);
    }

    /// @notice Settle a funded escrow on an authorized verdict. The on-chain outcome is DERIVED
    ///         from verdictCode here — the settlement wallet cannot pass an outcome that
    ///         contradicts the recorded verdict (M-3). pass->release, abstain->abstain-default,
    ///         everything else (fail/partial/unknown)->refund (payer-protective default).
    /// @param verdictCode 0=pass 1=fail 2=partial 3=abstain
    /// @param evidenceHash keccak256 of the canonical evidence bundle
    function settle(bytes32 workId, uint8 verdictCode, bytes32 evidenceHash)
        external
        onlyVerdict
    {
        Escrow storage e = escrows[workId];
        require(e.status == STATUS_FUNDED, "not funded"); // status guard: no double-settle

        uint8 outcome = verdictCode == 0
            ? OUTCOME_RELEASE
            : (verdictCode == 3 ? OUTCOME_ABSTAIN : OUTCOME_REFUND);

        e.status = STATUS_SETTLED;
        e.outcome = outcome;
        e.verdictCode = verdictCode;
        e.evidenceHash = evidenceHash;
        totalEscrowed -= e.amount;

        address to = outcome == OUTCOME_RELEASE ? e.worker : e.payer;
        require(IERC20(USDC).transfer(to, e.amount), "transfer failed");

        emit Settled(workId, outcome, to, e.amount, verdictCode, evidenceHash);
    }

    /// @notice Recover USDC sitting in the contract that is NOT backing a funded escrow (e.g. a
    ///         stranded direct transfer). Can NEVER touch escrowed principal — it only moves the
    ///         balance above totalEscrowed.
    function sweep(address to) external onlyOwner {
        require(to != address(0), "to=0");
        uint256 free = IERC20(USDC).balanceOf(address(this)) - totalEscrowed; // >= 0 by construction
        require(free > 0, "nothing to sweep");
        require(IERC20(USDC).transfer(to, free), "transfer failed");
    }

    function getEscrow(bytes32 workId) external view returns (Escrow memory) {
        return escrows[workId];
    }

    /// @dev Split a 65-byte ECDSA signature into (v, r, s).
    function _split(bytes calldata sig) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        require(sig.length == 65, "bad sig len");
        r = bytes32(sig[0:32]);
        s = bytes32(sig[32:64]);
        v = uint8(sig[64]);
        if (v < 27) v += 27;
    }
}
