// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerdiktEscrow} from "../src/VerdiktEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockTokenMessenger} from "./mocks/MockTokenMessenger.sol";

contract VerdiktEscrowTest is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    VerdiktEscrow escrow;

    address payer = address(0xA11CE);
    address worker = address(0xB0B);
    address verdictWallet = address(0xDEAD);

    // 65-byte dummy signature (r||s||v). The mock ignores the signature; the contract's
    // _split only requires length 65 and v>=27.
    bytes constant SIG = hex"11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222" hex"1b";
    bytes32 constant WORK_ID = keccak256("work-1");
    bytes32 constant EVIDENCE = keccak256("evidence-bundle");
    uint256 constant AMT = 5_000000; // 5 USDC (6 decimals)

    // Arc CCTP V2 TokenMessengerV2 address the escrow hardcodes for outbound payouts.
    address constant TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    function setUp() public {
        MockUSDC impl = new MockUSDC();
        vm.etch(USDC, address(impl).code);
        MockUSDC(USDC).mint(payer, 100_000000);

        // Etch a mock TokenMessenger at the address the escrow calls for cross-chain payouts.
        MockTokenMessenger tm = new MockTokenMessenger(USDC);
        vm.etch(TOKEN_MESSENGER, address(tm).code);

        escrow = new VerdiktEscrow(verdictWallet);
    }

    // Local (Arc) payout routes — recipient 0 means pay on Arc to the on-chain party.
    function _local() internal pure returns (VerdiktEscrow.PayoutRoutes memory) {
        return VerdiktEscrow.PayoutRoutes(0, bytes32(0), 0, bytes32(0));
    }

    function _fund() internal {
        vm.prank(payer);
        escrow.fundWithAuthorization(WORK_ID, worker, AMT, 0, type(uint256).max, SIG, _local());
    }

    function testFundLocksUsdc() public {
        _fund();
        assertEq(MockUSDC(USDC).balanceOf(address(escrow)), AMT);
        VerdiktEscrow.Escrow memory e = escrow.getEscrow(WORK_ID);
        assertEq(e.payer, payer);
        assertEq(e.worker, worker);
        assertEq(e.amount, AMT);
        assertEq(e.status, 1); // FUNDED
    }

    function testCannotDoubleFund() public {
        _fund();
        vm.prank(payer);
        vm.expectRevert("workId exists");
        escrow.fundWithAuthorization(WORK_ID, worker, AMT, 0, type(uint256).max, SIG, _local());
    }

    function testSettleReleaseToWorker() public {
        _fund();
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 0, EVIDENCE); // verdictCode=pass -> release
        assertEq(MockUSDC(USDC).balanceOf(worker), AMT);
        VerdiktEscrow.Escrow memory e = escrow.getEscrow(WORK_ID);
        assertEq(e.status, 2); // SETTLED
        assertEq(e.outcome, 0);
        assertEq(e.verdictCode, 0);
        assertEq(e.evidenceHash, EVIDENCE);
    }

    function testSettleRefundToPayer() public {
        _fund();
        uint256 before = MockUSDC(USDC).balanceOf(payer);
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 1, EVIDENCE); // verdictCode=fail -> refund
        assertEq(MockUSDC(USDC).balanceOf(payer), before + AMT);
    }

    function testAbstainRefundsToPayer() public {
        _fund();
        uint256 before = MockUSDC(USDC).balanceOf(payer);
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 3, EVIDENCE); // verdictCode=abstain -> abstain-default (payer)
        assertEq(MockUSDC(USDC).balanceOf(payer), before + AMT);
    }

    function testOnlyVerdictCanSettle() public {
        _fund();
        vm.prank(payer);
        vm.expectRevert("not verdict");
        escrow.settle(WORK_ID, 0, EVIDENCE);
    }

    function testCannotDoubleSettle() public {
        _fund();
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 0, EVIDENCE);
        vm.prank(verdictWallet);
        vm.expectRevert("not funded");
        escrow.settle(WORK_ID, 1, EVIDENCE);
    }

    // M-3: totalEscrowed accounting tracks funded principal and zeroes on settle.
    function testTotalEscrowedAccounting() public {
        assertEq(escrow.totalEscrowed(), 0);
        _fund();
        assertEq(escrow.totalEscrowed(), AMT, "funded principal tracked");
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 0, EVIDENCE);
        assertEq(escrow.totalEscrowed(), 0, "settle releases the accounting");
    }

    // H-1: sweep() recovers stray USDC (e.g. a stranded direct transfer) but can NEVER touch
    // funded principal — only the balance above totalEscrowed.
    function testSweepRecoversStrandedButNotFunded() public {
        _fund(); // AMT locked in escrow, totalEscrowed == AMT
        MockUSDC(USDC).mint(address(escrow), 7_000000); // 7 USDC stranded (no escrow record)
        uint256 ownerAddr = MockUSDC(USDC).balanceOf(address(this));
        escrow.sweep(address(this)); // owner == this (deployer)
        assertEq(MockUSDC(USDC).balanceOf(address(this)), ownerAddr + 7_000000, "only stray swept");
        assertEq(MockUSDC(USDC).balanceOf(address(escrow)), AMT, "funded principal untouched");
        // The funded escrow still settles in full afterwards.
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 0, EVIDENCE);
        assertEq(MockUSDC(USDC).balanceOf(worker), AMT, "worker still paid full principal");
    }

    function testSweepNothingToSweepReverts() public {
        _fund(); // balance == totalEscrowed, nothing free
        vm.expectRevert("nothing to sweep");
        escrow.sweep(address(this));
    }

    function testSweepOnlyOwner() public {
        MockUSDC(USDC).mint(address(escrow), 1_000000);
        vm.prank(address(0xBAD));
        vm.expectRevert("not owner");
        escrow.sweep(address(0xBAD));
    }

    // ----- X1: cross-chain funding path (fundCrossChain, called by the authorized hook) -----

    address hook = address(0x40004);
    bytes32 constant WORK_ID_2 = keccak256("work-cc");

    // Authorize the hook, give it USDC + an approval to the escrow, like CCTP minting to the hook.
    function _setupHook(uint256 amt) internal {
        escrow.setHook(hook);
        MockUSDC(USDC).mint(hook, amt);
        vm.prank(hook);
        MockUSDC(USDC).approve(address(escrow), amt);
    }

    function _fundCrossChain(uint256 amt) internal {
        vm.prank(hook);
        escrow.fundCrossChain(WORK_ID_2, payer, worker, amt, _local());
    }

    function testSetHookOnlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert("not owner");
        escrow.setHook(hook);
    }

    function testSetHookStoresAddress() public {
        escrow.setHook(hook);
        assertEq(escrow.hook(), hook);
    }

    function testFundCrossChainHappyPath() public {
        _setupHook(AMT);
        _fundCrossChain(AMT);
        assertEq(MockUSDC(USDC).balanceOf(address(escrow)), AMT, "principal pulled into escrow");
        assertEq(MockUSDC(USDC).balanceOf(hook), 0, "hook drained");
        VerdiktEscrow.Escrow memory e = escrow.getEscrow(WORK_ID_2);
        assertEq(e.payer, payer);
        assertEq(e.worker, worker);
        assertEq(e.amount, AMT);
        assertEq(e.status, 1); // FUNDED
    }

    function testFundCrossChainOnlyHook() public {
        _setupHook(AMT);
        vm.prank(address(0xBAD));
        vm.expectRevert("not hook");
        escrow.fundCrossChain(WORK_ID_2, payer, worker, AMT, _local());
    }

    // With no hook set, hook == address(0); no real caller can satisfy msg.sender == hook.
    function testFundCrossChainBeforeHookSetReverts() public {
        vm.prank(hook);
        vm.expectRevert("not hook");
        escrow.fundCrossChain(WORK_ID_2, payer, worker, AMT, _local());
    }

    function testFundCrossChainWorkIdCollision() public {
        _setupHook(AMT * 2);
        _fundCrossChain(AMT);
        vm.prank(hook);
        vm.expectRevert("workId exists");
        escrow.fundCrossChain(WORK_ID_2, payer, worker, AMT, _local());
    }

    // A cross-chain-funded workId collides with a native EIP-3009-funded one too.
    function testFundCrossChainCollidesWithNativeFund() public {
        _fund(); // funds WORK_ID natively
        escrow.setHook(hook);
        MockUSDC(USDC).mint(hook, AMT);
        vm.prank(hook);
        MockUSDC(USDC).approve(address(escrow), AMT);
        vm.prank(hook);
        vm.expectRevert("workId exists");
        escrow.fundCrossChain(WORK_ID, payer, worker, AMT, _local()); // same WORK_ID as _fund()
    }

    function testFundCrossChainZeroGuards() public {
        _setupHook(AMT);
        vm.startPrank(hook);
        vm.expectRevert("amount=0");
        escrow.fundCrossChain(WORK_ID_2, payer, worker, 0, _local());
        vm.expectRevert("worker=0");
        escrow.fundCrossChain(WORK_ID_2, payer, address(0), AMT, _local());
        vm.expectRevert("payer=0");
        escrow.fundCrossChain(WORK_ID_2, address(0), worker, AMT, _local());
        vm.stopPrank();
    }

    function testFundCrossChainTotalEscrowedAndSettleRelease() public {
        _setupHook(AMT);
        assertEq(escrow.totalEscrowed(), 0);
        _fundCrossChain(AMT);
        assertEq(escrow.totalEscrowed(), AMT, "cross-chain principal tracked");
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID_2, 0, EVIDENCE); // release -> worker
        assertEq(MockUSDC(USDC).balanceOf(worker), AMT, "worker paid");
        assertEq(escrow.totalEscrowed(), 0, "accounting cleared");
    }

    function testFundCrossChainSettleRefund() public {
        _setupHook(AMT);
        _fundCrossChain(AMT);
        uint256 before = MockUSDC(USDC).balanceOf(payer);
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID_2, 1, EVIDENCE); // fail -> refund payer
        assertEq(MockUSDC(USDC).balanceOf(payer), before + AMT);
    }

    function testFundCrossChainSettleAbstain() public {
        _setupHook(AMT);
        _fundCrossChain(AMT);
        uint256 before = MockUSDC(USDC).balanceOf(payer);
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID_2, 3, EVIDENCE); // abstain -> payer default
        assertEq(MockUSDC(USDC).balanceOf(payer), before + AMT);
    }

    // sweep() must never touch cross-chain-funded principal either.
    function testSweepIgnoresCrossChainPrincipal() public {
        _setupHook(AMT);
        _fundCrossChain(AMT);
        MockUSDC(USDC).mint(address(escrow), 3_000000); // stranded
        escrow.sweep(address(this));
        assertEq(MockUSDC(USDC).balanceOf(address(escrow)), AMT, "principal untouched");
    }

    // ----- X2: cross-chain OUTBOUND payout (seller/payer receive on their home chain) -----

    event CrossChainPayout(
        bytes32 indexed workId, uint8 outcome, uint32 destinationDomain, bytes32 recipient, uint256 amount
    );

    function _fundWithRoutes(VerdiktEscrow.PayoutRoutes memory r) internal {
        vm.prank(payer);
        escrow.fundWithAuthorization(WORK_ID, worker, AMT, 0, type(uint256).max, SIG, r);
    }

    // RELEASE pays the seller OUT to Base (domain 6) via CCTP — no local Arc transfer.
    function testSettleReleaseCrossChainToSeller() public {
        bytes32 sellerOnBase = bytes32(uint256(uint160(address(0xBA5E))));
        _fundWithRoutes(VerdiktEscrow.PayoutRoutes(6, sellerOnBase, 0, bytes32(0)));

        vm.expectEmit(true, false, false, true);
        emit CrossChainPayout(WORK_ID, 0, 6, sellerOnBase, AMT);
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 0, EVIDENCE); // release

        assertEq(MockUSDC(USDC).balanceOf(worker), 0, "no local Arc payout");
        assertEq(MockUSDC(USDC).balanceOf(address(escrow)), 0, "principal burned out");
        assertEq(MockTokenMessenger(TOKEN_MESSENGER).lastDomain(), 6, "burned to Base");
        assertEq(MockTokenMessenger(TOKEN_MESSENGER).lastRecipient(), sellerOnBase);
        assertEq(MockTokenMessenger(TOKEN_MESSENGER).lastAmount(), AMT);
    }

    // REFUND returns the buyer's money OUT to Ethereum (domain 0).
    function testSettleRefundCrossChainToPayer() public {
        bytes32 buyerOnEth = bytes32(uint256(uint160(address(0xE74))));
        _fundWithRoutes(VerdiktEscrow.PayoutRoutes(0, bytes32(0), 0, buyerOnEth));

        vm.expectEmit(true, false, false, true);
        emit CrossChainPayout(WORK_ID, 1, 0, buyerOnEth, AMT);
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 1, EVIDENCE); // fail -> refund

        assertEq(MockUSDC(USDC).balanceOf(payer), 100_000000 - AMT, "no local refund (funded via mock)");
        assertEq(MockTokenMessenger(TOKEN_MESSENGER).lastDomain(), 0, "refunded to Ethereum");
        assertEq(MockTokenMessenger(TOKEN_MESSENGER).lastRecipient(), buyerOnEth);
    }

    // Buyer on ETH, seller on Base: worker route cross-chain, but a release only burns the worker leg.
    function testReleaseUsesWorkerRouteNotPayerRoute() public {
        bytes32 sellerOnBase = bytes32(uint256(uint160(address(0xBA5E))));
        bytes32 buyerOnEth = bytes32(uint256(uint160(address(0xE74))));
        _fundWithRoutes(VerdiktEscrow.PayoutRoutes(6, sellerOnBase, 0, buyerOnEth));
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 0, EVIDENCE); // release -> worker route (Base)
        assertEq(MockTokenMessenger(TOKEN_MESSENGER).lastRecipient(), sellerOnBase, "used worker route");
    }

    // A release with a LOCAL worker route still pays on Arc and never calls the TokenMessenger.
    function testLocalReleaseDoesNotBridge() public {
        _fundWithRoutes(VerdiktEscrow.PayoutRoutes(0, bytes32(0), 0, bytes32(0)));
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 0, EVIDENCE);
        assertEq(MockUSDC(USDC).balanceOf(worker), AMT, "paid locally on Arc");
        assertEq(MockTokenMessenger(TOKEN_MESSENGER).burnCount(), 0, "no bridge");
    }

    // The hook-funded (CCTP-in) path can also carry cross-chain payout routes end to end.
    function testCrossChainFundThenCrossChainRelease() public {
        bytes32 sellerOnBase = bytes32(uint256(uint160(address(0xBA5E))));
        escrow.setHook(hook);
        MockUSDC(USDC).mint(hook, AMT);
        vm.prank(hook);
        MockUSDC(USDC).approve(address(escrow), AMT);
        vm.prank(hook);
        escrow.fundCrossChain(WORK_ID_2, payer, worker, AMT, VerdiktEscrow.PayoutRoutes(6, sellerOnBase, 0, bytes32(0)));

        vm.prank(verdictWallet);
        escrow.settle(WORK_ID_2, 0, EVIDENCE);
        assertEq(MockTokenMessenger(TOKEN_MESSENGER).lastRecipient(), sellerOnBase, "in-and-out cross-chain");
    }
}
