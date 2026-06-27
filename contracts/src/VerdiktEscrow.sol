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

    address public owner;
    address public verdict; // settlement orchestrator wallet (Circle DCW)

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

    /// @notice Payer funds the escrow: pulls `amount` USDC from msg.sender into this
    ///         contract via EIP-3009 and records the escrow atomically.
    /// @dev    `from` of the authorization is forced to msg.sender (the payer), and the
    ///         EIP-3009 `nonce` is DERIVED from (workId, worker, amount, payer). A
    ///         mempool observer who copies the payer's signed blob but changes workId
    ///         or worker computes a different nonce, so the signature no longer recovers
    ///         and the token reverts — the authorization is bound to this exact task.
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
        IERC3009(USDC).transferWithAuthorization(
            msg.sender, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );

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

    /// @notice Settle a funded escrow on an authorized verdict.
    /// @param outcome 0=release(worker) 1=refund(payer) 2=abstain-default(payer)
    /// @param verdictCode 0=pass 1=fail 2=partial 3=abstain
    /// @param evidenceHash keccak256 of the canonical evidence bundle
    function settle(bytes32 workId, uint8 outcome, uint8 verdictCode, bytes32 evidenceHash)
        external
        onlyVerdict
    {
        require(outcome <= OUTCOME_ABSTAIN, "bad outcome");
        Escrow storage e = escrows[workId];
        require(e.status == STATUS_FUNDED, "not funded"); // status guard: no double-settle

        e.status = STATUS_SETTLED;
        e.outcome = outcome;
        e.verdictCode = verdictCode;
        e.evidenceHash = evidenceHash;

        address to = outcome == OUTCOME_RELEASE ? e.worker : e.payer;
        require(IERC20(USDC).transfer(to, e.amount), "transfer failed");

        emit Settled(workId, outcome, to, e.amount, verdictCode, evidenceHash);
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
