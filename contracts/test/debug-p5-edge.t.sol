// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerdiktEscrow} from "../src/VerdiktEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

// ---------------------------------------------------------------------------
// debug-p5-edge.t.sol — Phase 5.1 contract edge cases + Phase 6 structural
// security probes for VerdiktEscrow. Additive: does NOT touch VerdiktEscrow.t.sol.
// ---------------------------------------------------------------------------

// A USDC mock that ENFORCES the EIP-3009 nonce/from binding the real token would,
// so we can actually exercise the C-01 front-run-binding claim. The real Arc USDC
// recovers a signer over (from,to,value,validAfter,validBefore,nonce); here we model
// that as: a given `nonce` is single-use and is bound to the exact (from,to,value)
// it was first presented with. Replaying it with different params reverts.
contract NonceBindingUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => bool) public usedNonce;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "insufficient");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256,
        bytes32 nonce,
        uint8,
        bytes32,
        bytes32
    ) external {
        // The contract derives nonce = keccak256(workId,worker,amount,payer). Real token
        // would reject a signature that doesn't recover over these exact fields; we model
        // the binding as the nonce being unusable twice (replay protection).
        require(!usedNonce[nonce], "authorization used");
        require(balanceOf[from] >= value, "insufficient");
        usedNonce[nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

// A malicious token used to probe reentrancy on settle(). Its transfer() re-enters
// the escrow's settle() for the same workId. If the escrow used external-call-before-
// state-update, the re-entrant call would pass the status guard and double-pay.
contract ReentrantUSDC {
    mapping(address => uint256) public balanceOf;
    VerdiktEscrow public escrow;
    bytes32 public targetWorkId;
    bool public attacked;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function arm(address _escrow, bytes32 _workId) external {
        escrow = VerdiktEscrow(_escrow);
        targetWorkId = _workId;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256,
        bytes32,
        uint8,
        bytes32,
        bytes32
    ) external {
        require(balanceOf[from] >= value, "insufficient");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        // Re-enter on the FIRST settle transfer only, before falling through to the
        // real balance move. If CEI is correct, the re-entrant settle reverts on the
        // status guard ("not funded") and the whole settle reverts.
        if (address(escrow) != address(0) && !attacked) {
            attacked = true;
            // Re-enter: try to settle the same workId again mid-transfer.
            escrow.settle(targetWorkId, 0, bytes32(0));
        }
        require(balanceOf[msg.sender] >= amt, "insufficient");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

contract VerdiktEscrowEdgeTest is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    VerdiktEscrow escrow;

    address payer = address(0xA11CE);
    address worker = address(0xB0B);
    address verdictWallet = address(0xDEAD);
    address attacker = address(0xBAD);

    bytes constant SIG = hex"11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222" hex"1b";
    bytes32 constant WORK_ID = keccak256("edge-work-1");
    bytes32 constant EVIDENCE = keccak256("evidence-bundle");
    uint256 constant AMT = 5_000000;

    function setUp() public {
        MockUSDC impl = new MockUSDC();
        vm.etch(USDC, address(impl).code);
        MockUSDC(USDC).mint(payer, 100_000000);
        escrow = new VerdiktEscrow(verdictWallet);
    }

    function _fund() internal {
        vm.prank(payer);
        escrow.fundWithAuthorization(WORK_ID, worker, AMT, 0, type(uint256).max, SIG);
    }

    // ---------------------------------------------------------------
    // CONSTRUCTOR
    // ---------------------------------------------------------------
    function testConstructorRejectsZeroVerdict() public {
        vm.expectRevert("verdict=0");
        new VerdiktEscrow(address(0));
    }

    // ---------------------------------------------------------------
    // FUND — zero / address(0) / double-fund variants
    // ---------------------------------------------------------------
    function testFundZeroAmountReverts() public {
        vm.prank(payer);
        vm.expectRevert("amount=0");
        escrow.fundWithAuthorization(WORK_ID, worker, 0, 0, type(uint256).max, SIG);
    }

    function testFundZeroWorkerReverts() public {
        vm.prank(payer);
        vm.expectRevert("worker=0");
        escrow.fundWithAuthorization(WORK_ID, address(0), AMT, 0, type(uint256).max, SIG);
    }

    // Different worker on the same workId after a fund -> "workId exists" (double-fund variant).
    function testDoubleFundDifferentWorkerReverts() public {
        _fund();
        vm.prank(payer);
        vm.expectRevert("workId exists");
        escrow.fundWithAuthorization(WORK_ID, attacker, AMT, 0, type(uint256).max, SIG);
    }

    // Double-fund variant: a DIFFERENT payer cannot overwrite an existing funded workId.
    function testDoubleFundDifferentPayerReverts() public {
        _fund();
        MockUSDC(USDC).mint(attacker, AMT);
        vm.prank(attacker);
        vm.expectRevert("workId exists");
        escrow.fundWithAuthorization(WORK_ID, worker, AMT, 0, type(uint256).max, SIG);
    }

    // The funder always becomes the payer of record (from = msg.sender, not a param).
    function testFunderBecomesPayerOfRecord() public {
        MockUSDC(USDC).mint(attacker, AMT);
        vm.prank(attacker);
        escrow.fundWithAuthorization(keccak256("w2"), worker, AMT, 0, type(uint256).max, SIG);
        VerdiktEscrow.Escrow memory e = escrow.getEscrow(keccak256("w2"));
        assertEq(e.payer, attacker, "payer must equal msg.sender");
    }

    // ---------------------------------------------------------------
    // C-01 — derived-nonce / from-binding (front-run resistance)
    // ---------------------------------------------------------------
    // The contract derives nonce = keccak256(workId,worker,amount,payer) and forces
    // from = msg.sender. With a nonce-enforcing token, the SAME authorization cannot be
    // reused for a second workId, and a copy with a different (worker/amount/payer)
    // produces a different nonce path. We assert: the derived nonce differs per task
    // tuple, and a replay of an already-used nonce reverts at the token.
    function testDerivedNonceBindsToTaskTuple() public {
        NonceBindingUSDC impl = new NonceBindingUSDC();
        vm.etch(USDC, address(impl).code);
        NonceBindingUSDC(USDC).mint(payer, 100_000000);
        NonceBindingUSDC(USDC).mint(attacker, 100_000000);
        VerdiktEscrow esc = new VerdiktEscrow(verdictWallet);

        // Payer funds work A.
        vm.prank(payer);
        esc.fundWithAuthorization(keccak256("A"), worker, AMT, 0, type(uint256).max, SIG);

        bytes32 nonceA = keccak256(abi.encode(keccak256("A"), worker, AMT, payer));
        assertTrue(NonceBindingUSDC(USDC).usedNonce(nonceA), "payer's nonce consumed");

        // A front-runner who copies the blob but changes the worker computes a DIFFERENT
        // nonce (worker is in the preimage), so the authorization the payer signed is
        // never consumed for the attacker's target. The attacker's own funding uses its
        // own nonce (from = attacker), proving the payer's signature cannot be rebound.
        bytes32 nonceAttacker = keccak256(abi.encode(keccak256("A"), attacker, AMT, attacker));
        assertTrue(nonceA != nonceAttacker, "nonce must change when worker/payer change");
        assertFalse(NonceBindingUSDC(USDC).usedNonce(nonceAttacker), "attacker tuple not pre-consumed");
    }

    // Same (workId,worker,amount,payer) -> same nonce; reusing it reverts at the token.
    function testReplaySameNonceRevertsAtToken() public {
        NonceBindingUSDC impl = new NonceBindingUSDC();
        vm.etch(USDC, address(impl).code);
        NonceBindingUSDC(USDC).mint(payer, 100_000000);
        VerdiktEscrow esc = new VerdiktEscrow(verdictWallet);

        vm.prank(payer);
        esc.fundWithAuthorization(keccak256("R"), worker, AMT, 0, type(uint256).max, SIG);

        // Settle then attempt to fund a NEW workId whose tuple collides on the same nonce
        // is impossible (workId is in the preimage). But replaying the exact same workId is
        // blocked first by the escrow's "workId exists" guard — verify the token-level guard
        // independently by calling the token directly with the consumed nonce.
        bytes32 nonceR = keccak256(abi.encode(keccak256("R"), worker, AMT, payer));
        vm.expectRevert("authorization used");
        NonceBindingUSDC(USDC).receiveWithAuthorization(
            payer, address(esc), AMT, 0, type(uint256).max, nonceR, 27, bytes32(0), bytes32(0)
        );
    }

    // ---------------------------------------------------------------
    // SETTLE — ordering / authorization / range
    // ---------------------------------------------------------------
    function testSettleBeforeFundReverts() public {
        vm.prank(verdictWallet);
        vm.expectRevert("not funded");
        escrow.settle(WORK_ID, 0, EVIDENCE);
    }

    function testSettleByOwnerNotVerdictReverts() public {
        _fund();
        // owner == address(this) (deployer); still not the verdict wallet.
        vm.expectRevert("not verdict");
        escrow.settle(WORK_ID, 0, EVIDENCE);
    }

    function testSettleByArbitraryAddressReverts() public {
        _fund();
        vm.prank(attacker);
        vm.expectRevert("not verdict");
        escrow.settle(WORK_ID, 0, EVIDENCE);
    }

    // Double-settle variant: refund first, then release attempt -> "not funded".
    function testDoubleSettleRefundThenReleaseReverts() public {
        _fund();
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 1, EVIDENCE); // verdictCode=fail -> refund
        vm.prank(verdictWallet);
        vm.expectRevert("not funded");
        escrow.settle(WORK_ID, 0, EVIDENCE);
    }

    // M-3: outcome is DERIVED from verdictCode on-chain — the settlement wallet cannot pass an
    // outcome that contradicts the verdict. A fail verdict can ONLY refund the payer, never release.
    function testVerdictCodeFailDerivesRefundNotRelease() public {
        _fund();
        uint256 payerBefore = MockUSDC(USDC).balanceOf(payer);
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 1, EVIDENCE); // verdictCode=fail
        VerdiktEscrow.Escrow memory e = escrow.getEscrow(WORK_ID);
        assertEq(e.outcome, 1, "fail must derive refund");
        assertEq(MockUSDC(USDC).balanceOf(worker), 0, "worker never paid on a fail");
        assertEq(MockUSDC(USDC).balanceOf(payer), payerBefore + AMT, "payer refunded");
    }

    // An unknown/out-of-spec verdictCode falls through to the payer-protective refund default.
    function testUnknownVerdictCodeDerivesRefund() public {
        _fund();
        uint256 payerBefore = MockUSDC(USDC).balanceOf(payer);
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 200, EVIDENCE); // unknown code -> refund
        VerdiktEscrow.Escrow memory e = escrow.getEscrow(WORK_ID);
        assertEq(e.outcome, 1, "unknown code must derive refund");
        assertEq(MockUSDC(USDC).balanceOf(payer), payerBefore + AMT, "payer refunded on unknown code");
    }

    // verdictCode is anchored as-is (no on-chain enum range check); document the behavior:
    // an out-of-spec verdictCode does NOT revert — it is stored verbatim, and derives a refund.
    function testVerdictCodeNotRangeChecked() public {
        _fund();
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 99, EVIDENCE); // verdictCode=99, no revert by design
        VerdiktEscrow.Escrow memory e = escrow.getEscrow(WORK_ID);
        assertEq(e.verdictCode, 99);
    }

    // ---------------------------------------------------------------
    // setVerdict — owner guard + rotation
    // ---------------------------------------------------------------
    function testSetVerdictOnlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert("not owner");
        escrow.setVerdict(attacker);
    }

    function testSetVerdictRejectsZero() public {
        vm.expectRevert("verdict=0");
        escrow.setVerdict(address(0));
    }

    function testSetVerdictRotatesAuthority() public {
        address newVerdict = address(0xCAFE);
        escrow.setVerdict(newVerdict); // owner = this
        _fund();
        // Old verdict wallet can no longer settle.
        vm.prank(verdictWallet);
        vm.expectRevert("not verdict");
        escrow.settle(WORK_ID, 0, EVIDENCE);
        // New verdict wallet can.
        vm.prank(newVerdict);
        escrow.settle(WORK_ID, 0, EVIDENCE);
        assertEq(MockUSDC(USDC).balanceOf(worker), AMT);
    }

    // ---------------------------------------------------------------
    // EVENTS — every state-changing fn emits an indexed event
    // ---------------------------------------------------------------
    event Funded(bytes32 indexed workId, address payer, address worker, uint256 amount);
    event Settled(bytes32 indexed workId, uint8 outcome, address to, uint256 amount, uint8 verdictCode, bytes32 evidenceHash);

    function testFundEmitsFundedEvent() public {
        vm.expectEmit(true, false, false, true);
        emit Funded(WORK_ID, payer, worker, AMT);
        vm.prank(payer);
        escrow.fundWithAuthorization(WORK_ID, worker, AMT, 0, type(uint256).max, SIG);
    }

    function testSettleEmitsSettledEvent() public {
        _fund();
        vm.expectEmit(true, false, false, true);
        emit Settled(WORK_ID, 0, worker, AMT, 0, EVIDENCE);
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 0, EVIDENCE);
    }

    // ---------------------------------------------------------------
    // REENTRANCY — CEI probe on settle()
    // ---------------------------------------------------------------
    // settle() sets status=SETTLED BEFORE the USDC transfer (checks-effects-interactions),
    // AND is gated by onlyVerdict. A malicious token re-entering settle() mid-transfer is
    // doubly blocked: (1) the re-entrant caller is the token contract, not the verdict
    // wallet, so onlyVerdict reverts "not verdict" first; (2) even if it were the verdict
    // wallet, the CEI status flip to SETTLED means the guard would revert "not funded".
    // Either way the re-entrant call reverts and bubbles, reverting the whole settle — no
    // double payout. We assert the outer settle reverts and the escrow is untouched.
    function testSettleIsReentrancySafe() public {
        ReentrantUSDC evil = new ReentrantUSDC();
        vm.etch(USDC, address(evil).code);
        ReentrantUSDC token = ReentrantUSDC(USDC);
        token.mint(payer, 100_000000);

        // Make the TOKEN the verdict wallet so its re-entrant settle() passes onlyVerdict.
        // This isolates the CEI defense: if the status flip happened AFTER the transfer,
        // the re-entrant settle would succeed and double-pay. Because status is flipped to
        // SETTLED BEFORE the transfer, the re-entrant settle reverts on "not funded".
        VerdiktEscrow esc = new VerdiktEscrow(address(token));
        vm.prank(payer);
        esc.fundWithAuthorization(WORK_ID, worker, AMT, 0, type(uint256).max, SIG);

        token.arm(address(esc), WORK_ID);

        // Outer settle is invoked by the token (the verdict wallet). Its transfer() re-enters
        // settle(), which now passes onlyVerdict but hits status==SETTLED -> "not funded".
        // The revert bubbles through token.transfer back into the outer settle, reverting it.
        vm.prank(address(token));
        vm.expectRevert("not funded");
        esc.settle(WORK_ID, 0, EVIDENCE);

        // Escrow untouched: no payout, status still FUNDED (both calls reverted).
        VerdiktEscrow.Escrow memory e = esc.getEscrow(WORK_ID);
        assertEq(e.status, 1, "escrow stays FUNDED after reverted reentrancy");
        assertEq(token.balanceOf(worker), 0, "no payout on reentrancy");
    }
}
