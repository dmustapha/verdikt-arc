// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/// @dev Circle CCTP V2 MessageTransmitterV2 — the only method we call.
interface IReceiverV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation)
        external
        returns (bool);
}

/// @dev VerdiktEscrow cross-chain funding entrypoint + payout-route shape (mirrors the contract).
interface IVerdiktEscrow {
    struct PayoutRoutes {
        uint32 workerDomain;
        bytes32 workerRecipient;
        uint32 payerDomain;
        bytes32 payerRecipient;
    }

    function fundCrossChain(
        bytes32 workId,
        address payer,
        address worker,
        uint256 amount,
        uint256 fee,
        uint256 ttl,
        PayoutRoutes calldata routes
    ) external;
}

/// @title EscrowFundingHook
/// @notice Atomically turns a Circle CCTP V2 cross-chain USDC transfer into a funded Verdikt
///         escrow on Arc. CCTP core does NOT execute hooks — `depositForBurnWithHook` only carries
///         `hookData` as opaque metadata and mints USDC to `mintRecipient` with no callback. So this
///         contract IS the `mintRecipient` (and `destinationCaller`): in one transaction it calls
///         MessageTransmitterV2.receiveMessage (minting the USDC to itself), reads the amount it
///         actually received, decodes {workId, payer, worker} from the Iris-attested message, and
///         funds the escrow. Non-custodial: USDC only ever rests here for the span of a single tx.
contract EscrowFundingHook {
    IReceiverV2 public immutable messageTransmitter;
    IERC20 public immutable usdc;
    IVerdiktEscrow public immutable escrow;
    address public owner;

    // CCTP V2 message layout: hookData is the trailing field of the message body.
    // 148 (MessageV2 header) + 228 (BurnMessageV2 hookData offset) = 376. hookData runs to the end.
    uint256 private constant HOOK_DATA_OFFSET = 376;
    // hookData = abi.encode(workId, payer, worker, fee, ttl, workerDomain, workerRecipient,
    // payerDomain, payerRecipient) = 9 * 32 bytes. fee/ttl carry the verdict-fee split and no-show
    // deadline through the bridge; the payout routes let the buyer settle/refund cross-chain too.
    uint256 private constant HOOK_DATA_LEN = 288;
    // Recovery-fallback deadline for adminFundFromBalance (owner manually funds a rescued mint).
    uint256 private constant ADMIN_FALLBACK_TTL = 7 days;

    bool private locked;

    event CrossChainFunded(
        bytes32 indexed workId, address payer, address worker, uint256 amount
    );
    event Rescued(address indexed to, uint256 amount);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "reentrant");
        locked = true;
        _;
        locked = false;
    }

    constructor(address _messageTransmitter, address _usdc, address _escrow, address _owner) {
        require(_messageTransmitter != address(0), "transmitter=0");
        require(_usdc != address(0), "usdc=0");
        require(_escrow != address(0), "escrow=0");
        require(_owner != address(0), "owner=0");
        messageTransmitter = IReceiverV2(_messageTransmitter);
        usdc = IERC20(_usdc);
        escrow = IVerdiktEscrow(_escrow);
        owner = _owner;
    }

    /// @notice Permissionless happy path: relay an attested CCTP message + attestation. Mints the
    ///         USDC to this contract and funds the escrow for the committed {workId, payer, worker}.
    /// @dev    The amount is MEASURED as the balance delta (fee-net), never trusted from the message
    ///         — Fast Transfer deducts a fee, so the minted amount < the burned amount. The escrow
    ///         params come from the attested hookData and cannot be forged, so anyone may relay:
    ///         a replayer either funds the escrow exactly as the payer intended, or reverts on the
    ///         already-consumed CCTP nonce inside receiveMessage. No griefing path exists.
    function mintAndFund(bytes calldata message, bytes calldata attestation) external nonReentrant {
        require(message.length >= HOOK_DATA_OFFSET + HOOK_DATA_LEN, "message too short");

        uint256 balBefore = usdc.balanceOf(address(this));
        require(messageTransmitter.receiveMessage(message, attestation), "receiveMessage failed");
        uint256 minted = usdc.balanceOf(address(this)) - balBefore;
        require(minted > 0, "nothing minted");

        (
            bytes32 workId, address payer, address worker,
            uint256 fee, uint256 ttl,
            uint32 workerDomain, bytes32 workerRecipient,
            uint32 payerDomain, bytes32 payerRecipient
        ) = abi.decode(
            message[HOOK_DATA_OFFSET:],
            (bytes32, address, address, uint256, uint256, uint32, bytes32, uint32, bytes32)
        );

        usdc.approve(address(escrow), minted);
        escrow.fundCrossChain(
            workId, payer, worker, minted, fee, ttl,
            IVerdiktEscrow.PayoutRoutes(workerDomain, workerRecipient, payerDomain, payerRecipient)
        );
        emit CrossChainFunded(workId, payer, worker, minted);
    }

    /// @notice Owner valve: mint an attested CCTP message into this contract WITHOUT funding the
    ///         escrow. Recovers source funds if a workId is poisoned (already funded/settled on Arc)
    ///         so mintAndFund would revert forever. Pair with rescue or adminFundFromBalance.
    function adminMint(bytes calldata message, bytes calldata attestation)
        external
        onlyOwner
        nonReentrant
    {
        require(messageTransmitter.receiveMessage(message, attestation), "receiveMessage failed");
    }

    /// @notice Owner valve / documented fallback: fund the escrow from USDC already held here
    ///         (e.g. after adminMint, or a manually-relayed receiveMessage).
    function adminFundFromBalance(bytes32 workId, address payer, address worker, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        require(amount > 0, "amount=0");
        require(usdc.balanceOf(address(this)) >= amount, "insufficient balance");
        usdc.approve(address(escrow), amount);
        // Recovery fallback funds with LOCAL (Arc) payout routes and no verdict fee — the operator
        // settles manually. A fixed fallback TTL keeps the no-show refund path available.
        escrow.fundCrossChain(
            workId, payer, worker, amount, 0, ADMIN_FALLBACK_TTL,
            IVerdiktEscrow.PayoutRoutes(0, bytes32(0), 0, bytes32(0))
        );
        emit CrossChainFunded(workId, payer, worker, amount);
    }

    /// @notice Sweep any USDC stranded in this contract (dust, direct transfers, recovered mints).
    ///         Cannot touch escrowed principal — funds in the escrow are not here.
    function rescue(address to) external onlyOwner {
        require(to != address(0), "to=0");
        uint256 bal = usdc.balanceOf(address(this));
        require(bal > 0, "nothing to rescue");
        require(usdc.transfer(to, bal), "transfer failed");
        emit Rescued(to, bal);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner=0");
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }
}
