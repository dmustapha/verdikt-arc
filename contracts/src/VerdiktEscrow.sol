// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @dev Circle CCTP V2 TokenMessengerV2 on Arc — used to pay a seller/payer OUT to their home chain.
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

/// @title VerdiktEscrow (v5)
/// @notice Holds a buyer's USDC (bounty + verdict fee) against a task and settles ONLY on an
///         authorized verdict: release (worker paid the bounty), refund (buyer gets the bounty back),
///         abstain (buyer refunded in full, no fee), partial (real bps split of the bounty), or a
///         permissionless no-show refund past a deadline. The verdict fee is escrow-funded by the
///         buyer and paid to Verdikt only when a definitive verdict is rendered — sellers never pay
///         to get judged. Both parties may declare a cross-chain payout route (any CCTP V2 chain):
///         Arc is the neutral clearing house — the money settles here and is paid out to home chains.
contract VerdiktEscrow {
    // Arc testnet USDC predeploy (6 decimals). Fixed — not configurable.
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    // Arc CCTP V2 TokenMessengerV2 (deterministic; verified on-chain via localMessageTransmitter()).
    ITokenMessengerV2 private constant TOKEN_MESSENGER =
        ITokenMessengerV2(0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA);
    // Arc is a STANDARD-only CCTP source, but reaches hard finality in ~1 block (~0.5s) and charges
    // NO fee on standard transfers — so an outbound payout is effectively fast AND exact (no fee math).
    uint32 private constant OUTBOUND_FINALITY = 2000;

    uint16 private constant BPS_DENOMINATOR = 10_000;

    uint8 private constant STATUS_EMPTY = 0;
    uint8 private constant STATUS_FUNDED = 1;
    uint8 private constant STATUS_SETTLED = 2;

    uint8 private constant OUTCOME_RELEASE = 0; // -> worker (bounty)
    uint8 private constant OUTCOME_REFUND = 1; // -> payer (bounty), fee earned
    uint8 private constant OUTCOME_ABSTAIN = 2; // -> payer (bounty + fee), no fee taken
    uint8 private constant OUTCOME_PARTIAL = 3; // -> worker (bounty*bps) + payer (remainder), fee earned
    uint8 private constant OUTCOME_EXPIRED = 4; // -> payer (bounty + fee), no-show, no fee taken

    uint8 private constant VERDICT_PASS = 0;
    uint8 private constant VERDICT_FAIL = 1;
    uint8 private constant VERDICT_PARTIAL = 2;
    uint8 private constant VERDICT_ABSTAIN = 3;
    uint8 private constant VERDICT_NONE = 255; // sentinel: no verdict rendered (no-show expiry)

    struct Escrow {
        address payer;
        address worker;
        uint256 amount; // total escrowed USDC (6 decimals) = bounty + fee
        uint256 fee; // verdict fee, a subset of amount, paid to Verdikt on a definitive verdict
        uint256 deadline; // no-show refund becomes permissionlessly callable after this timestamp
        uint8 status; // 0 EMPTY, 1 FUNDED, 2 SETTLED
        uint8 outcome; // valid when SETTLED (see OUTCOME_* constants)
        uint8 verdictCode; // 0 pass,1 fail,2 partial,3 abstain,255 none(no-show)
        bytes32 evidenceHash; // anchored evidence commitment
        // Optional cross-chain payout routes (any CCTP V2 domain). recipient == 0 => pay locally on
        // Arc to the on-chain payer/worker address. Bound at fund time from the signed offer, so the
        // settlement wallet cannot redirect funds (it only reads these).
        uint32 workerPayoutDomain;
        bytes32 workerPayoutRecipient; // where a RELEASE / partial worker-cut pays the seller
        uint32 payerPayoutDomain;
        bytes32 payerPayoutRecipient; // where a REFUND/ABSTAIN/EXPIRED/partial-remainder returns funds
    }

    /// @notice Payout routes a payer commits at fund time (mirrors the signed offer).
    struct PayoutRoutes {
        uint32 workerDomain;
        bytes32 workerRecipient;
        uint32 payerDomain;
        bytes32 payerRecipient;
    }

    mapping(bytes32 => Escrow) private escrows;

    // Sum of USDC currently backing FUNDED escrows. Lets sweep() recover stray balance without
    // ever touching escrowed principal (free = balanceOf(this) - totalEscrowed).
    uint256 public totalEscrowed;

    address public owner;
    address public verdict; // settlement orchestrator wallet (Circle DCW)
    address public hook; // authorized cross-chain funder (EscrowFundingHook); funds CCTP-minted USDC
    address public feeRecipient; // Verdikt treasury on Arc; receives the verdict fee

    event Funded(
        bytes32 indexed workId, address payer, address worker, uint256 amount, uint256 fee, uint256 deadline
    );
    event Settled(
        bytes32 indexed workId,
        uint8 outcome,
        address to,
        uint256 amount,
        uint8 verdictCode,
        bytes32 evidenceHash
    );
    // Emitted for a real bps split. workerAmount + payerAmount == bounty; fee handled separately.
    event SettledPartial(
        bytes32 indexed workId,
        address workerTo,
        uint256 workerAmount,
        address payerTo,
        uint256 payerAmount,
        uint16 bps,
        bytes32 evidenceHash
    );
    // Emitted when a no-show escrow is refunded past its deadline (permissionless).
    event Expired(bytes32 indexed workId, address to, uint256 amount);
    // Emitted when the verdict fee is paid to the Verdikt treasury (definitive verdicts only).
    event FeePaid(bytes32 indexed workId, address to, uint256 amount);
    event VerdictUpdated(address indexed oldVerdict, address indexed newVerdict);
    event HookSet(address indexed oldHook, address indexed newHook);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    // Emitted alongside a settlement when the payout is bridged out to another chain via CCTP.
    event CrossChainPayout(
        bytes32 indexed workId,
        uint8 outcome,
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amount
    );

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
        feeRecipient = msg.sender; // default the treasury to the deployer; rotatable by owner
    }

    /// @notice Rotate the settlement wallet if the Circle DCW address changes.
    function setVerdict(address _verdict) external onlyOwner {
        require(_verdict != address(0), "verdict=0");
        emit VerdictUpdated(verdict, _verdict);
        verdict = _verdict;
    }

    /// @notice Rotate the Verdikt treasury that receives the verdict fee.
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "feeRecipient=0");
        emit FeeRecipientUpdated(feeRecipient, _feeRecipient);
        feeRecipient = _feeRecipient;
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
    ///         (workId, payer, worker, amount, fee, ttl) come from the Iris-attested CCTP message, so
    ///         the hook cannot fund a task the payer did not commit to.
    /// @dev    Checks-effects-interactions: record the escrow + bump totalEscrowed BEFORE the
    ///         external transferFrom. (USDC has no transfer callback, but CEI removes all doubt.)
    function fundCrossChain(
        bytes32 workId,
        address payer,
        address worker,
        uint256 amount,
        uint256 fee,
        uint256 ttl,
        PayoutRoutes calldata routes
    ) external {
        require(msg.sender == hook, "not hook");
        require(escrows[workId].status == STATUS_EMPTY, "workId exists");
        require(amount > 0, "amount=0");
        require(fee < amount, "fee>=amount");
        require(ttl > 0, "ttl=0");
        require(worker != address(0), "worker=0");
        require(payer != address(0), "payer=0");

        // Effects before the external transferFrom (CEI). _record writes the escrow + emits Funded.
        _record(workId, payer, worker, amount, fee, ttl, routes);
        require(IERC20(USDC).transferFrom(msg.sender, address(this), amount), "transferFrom failed");
    }

    /// @notice Payer funds the escrow: pulls `amount` (bounty + fee) USDC from msg.sender into this
    ///         contract via EIP-3009 and records the escrow atomically.
    /// @dev    `from` of the authorization is forced to msg.sender (the payer), and the
    ///         EIP-3009 `nonce` is DERIVED from (workId, worker, amount, fee, ttl, payer). A
    ///         mempool observer who copies the payer's signed blob but changes any bound field
    ///         computes a different nonce, so the signature no longer recovers and the token reverts
    ///         — the authorization is bound to this exact task and its exact economics.
    ///         We use receiveWithAuthorization (msg.sender == to enforced by the token), so the
    ///         ONLY way to redeem the payer's signature is through this function, which records the
    ///         escrow atomically. That closes the H-1 stranded-funds front-run.
    function fundWithAuthorization(
        bytes32 workId,
        address worker,
        uint256 amount,
        uint256 fee,
        uint256 ttl,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig,
        PayoutRoutes calldata routes
    ) external {
        require(escrows[workId].status == STATUS_EMPTY, "workId exists");
        require(amount > 0, "amount=0");
        require(fee < amount, "fee>=amount");
        require(ttl > 0, "ttl=0");
        require(worker != address(0), "worker=0");

        (uint8 v, bytes32 r, bytes32 s) = _split(sig);
        IERC3009(USDC).receiveWithAuthorization(
            msg.sender,
            address(this),
            amount,
            validAfter,
            validBefore,
            keccak256(abi.encode(workId, worker, amount, fee, ttl, msg.sender)),
            v,
            r,
            s
        );
        _record(workId, msg.sender, worker, amount, fee, ttl, routes);
    }

    /// @dev Write a FUNDED escrow, bump the accounting, and emit Funded. Shared by both funding
    ///      paths. deadline = now + ttl. Called AFTER the token pull on the native path and BEFORE
    ///      the transferFrom on the hook path — both correct because the state write is the effect.
    function _record(
        bytes32 workId,
        address payer,
        address worker,
        uint256 amount,
        uint256 fee,
        uint256 ttl,
        PayoutRoutes calldata routes
    ) internal {
        uint256 dl = block.timestamp + ttl;
        totalEscrowed += amount;
        escrows[workId] = Escrow({
            payer: payer,
            worker: worker,
            amount: amount,
            fee: fee,
            deadline: dl,
            status: STATUS_FUNDED,
            outcome: 0,
            verdictCode: 0,
            evidenceHash: bytes32(0),
            workerPayoutDomain: routes.workerDomain,
            workerPayoutRecipient: routes.workerRecipient,
            payerPayoutDomain: routes.payerDomain,
            payerPayoutRecipient: routes.payerRecipient
        });
        emit Funded(workId, payer, worker, amount, fee, dl);
    }

    /// @notice Settle a funded escrow on an authorized verdict (pass/fail/abstain). The on-chain
    ///         outcome is DERIVED from verdictCode — the settlement wallet cannot pass an outcome
    ///         that contradicts the recorded verdict (M-3). pass->release(bounty to worker, fee to
    ///         Verdikt); fail->refund(bounty to payer, fee to Verdikt); abstain->refund in full
    ///         (bounty + fee to payer, no fee taken). Partial verdicts MUST use settlePartial.
    /// @param verdictCode 0=pass 1=fail 3=abstain (2=partial is rejected here)
    /// @param evidenceHash keccak256 of the canonical evidence bundle
    function settle(bytes32 workId, uint8 verdictCode, bytes32 evidenceHash)
        external
        onlyVerdict
    {
        Escrow storage e = escrows[workId];
        require(e.status == STATUS_FUNDED, "not funded"); // status guard: no double-settle
        require(verdictCode != VERDICT_PARTIAL, "use settlePartial");

        uint8 outcome = verdictCode == VERDICT_PASS
            ? OUTCOME_RELEASE
            : (verdictCode == VERDICT_ABSTAIN ? OUTCOME_ABSTAIN : OUTCOME_REFUND);

        // Effects: mark settled + record verdict BEFORE any external transfer (CEI, no re-entry).
        e.status = STATUS_SETTLED;
        e.outcome = outcome;
        e.verdictCode = verdictCode;
        e.evidenceHash = evidenceHash;

        uint256 total = e.amount;
        uint256 fee = e.fee;
        uint256 bounty = total - fee;
        totalEscrowed -= total;

        address to;
        uint256 paid;
        if (outcome == OUTCOME_RELEASE) {
            paid = bounty;
            to = _route(workId, outcome, e.workerPayoutDomain, e.workerPayoutRecipient, e.worker, bounty);
            _payFee(workId, fee);
        } else if (outcome == OUTCOME_ABSTAIN) {
            // Engine could not decide: buyer refunded in full, Verdikt takes nothing.
            paid = total;
            to = _route(workId, outcome, e.payerPayoutDomain, e.payerPayoutRecipient, e.payer, total);
        } else {
            // REFUND (fail): buyer gets the bounty back; Verdikt earned the fee (verdict rendered).
            paid = bounty;
            to = _route(workId, outcome, e.payerPayoutDomain, e.payerPayoutRecipient, e.payer, bounty);
            _payFee(workId, fee);
        }

        emit Settled(workId, outcome, to, paid, verdictCode, evidenceHash);
    }

    /// @notice Settle a funded escrow with a real partial split: the worker earns `bounty*bps/1e4`
    ///         (cross-chain per the worker route), the payer gets the remainder back, and Verdikt
    ///         takes the fee (a partial is a definitive verdict). Fixes the old partial->refund.
    /// @param bps worker's share of the bounty in basis points, strictly in (0, 10000).
    function settlePartial(bytes32 workId, uint16 bps, bytes32 evidenceHash)
        external
        onlyVerdict
    {
        Escrow storage e = escrows[workId];
        require(e.status == STATUS_FUNDED, "not funded");
        require(bps > 0 && bps < BPS_DENOMINATOR, "bps out of range");

        // Effects first (CEI): two payouts + a fee transfer follow, all after state is finalized.
        e.status = STATUS_SETTLED;
        e.outcome = OUTCOME_PARTIAL;
        e.verdictCode = VERDICT_PARTIAL;
        e.evidenceHash = evidenceHash;

        uint256 total = e.amount;
        uint256 fee = e.fee;
        uint256 bounty = total - fee;
        uint256 workerAmount = (bounty * bps) / BPS_DENOMINATOR;
        uint256 payerAmount = bounty - workerAmount;
        totalEscrowed -= total;

        address workerTo =
            _route(workId, OUTCOME_PARTIAL, e.workerPayoutDomain, e.workerPayoutRecipient, e.worker, workerAmount);
        address payerTo =
            _route(workId, OUTCOME_PARTIAL, e.payerPayoutDomain, e.payerPayoutRecipient, e.payer, payerAmount);
        _payFee(workId, fee);

        emit SettledPartial(workId, workerTo, workerAmount, payerTo, payerAmount, bps, evidenceHash);
    }

    /// @notice No-show refund. If the seller never delivered and the deadline has passed, the buyer
    ///         (payer) OR the verdict keeper can trigger a full refund of the escrow (bounty + fee)
    ///         to the buyer. No verdict was rendered, so Verdikt takes no fee. Restricting the caller
    ///         to payer-or-verdict removes a griefing race where a third party expires a job the
    ///         instant its deadline passes while delivery/verification is still legitimately in
    ///         flight; the funds always return to the buyer, so only these two parties need the lever.
    function refundExpired(bytes32 workId) external {
        Escrow storage e = escrows[workId];
        require(e.status == STATUS_FUNDED, "not funded");
        require(msg.sender == e.payer || msg.sender == verdict, "not authorized");
        require(block.timestamp > e.deadline, "not expired");

        e.status = STATUS_SETTLED;
        e.outcome = OUTCOME_EXPIRED;
        e.verdictCode = VERDICT_NONE;

        uint256 total = e.amount;
        totalEscrowed -= total;
        address to = _route(workId, OUTCOME_EXPIRED, e.payerPayoutDomain, e.payerPayoutRecipient, e.payer, total);

        emit Expired(workId, to, total);
    }

    /// @dev Pay `amount` either locally on Arc (recipient 0) or cross-chain via CCTP V2 to the
    ///      party's home chain. Returns the effective recipient (the home-chain address for a
    ///      cross-chain payout) for honest ledger/event reporting. A zero amount is a no-op.
    function _route(
        bytes32 workId,
        uint8 outcome,
        uint32 dom,
        bytes32 rcpt,
        address localTo,
        uint256 amount
    ) internal returns (address effectiveTo) {
        if (amount == 0) return localTo;
        if (rcpt == bytes32(0)) {
            // Local payout: the party receives USDC here on Arc.
            require(IERC20(USDC).transfer(localTo, amount), "transfer failed");
            return localTo;
        }
        // Cross-chain payout: burn to the party's home chain via CCTP V2. Arc is a standard,
        // fee-free source with ~0.5s finality, so the recipient gets the exact amount.
        require(IERC20(USDC).approve(address(TOKEN_MESSENGER), amount), "approve failed");
        TOKEN_MESSENGER.depositForBurn(amount, dom, rcpt, USDC, bytes32(0), 0, OUTBOUND_FINALITY);
        emit CrossChainPayout(workId, outcome, dom, rcpt, amount);
        return address(uint160(uint256(rcpt)));
    }

    /// @dev Pay the verdict fee to the Verdikt treasury on Arc. No-op when fee is zero.
    function _payFee(bytes32 workId, uint256 fee) internal {
        if (fee == 0) return;
        require(IERC20(USDC).transfer(feeRecipient, fee), "fee transfer failed");
        emit FeePaid(workId, feeRecipient, fee);
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
