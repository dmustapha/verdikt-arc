// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerdiktEscrow} from "../src/VerdiktEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

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
        escrow.fundWithAuthorization(WORK_ID, worker, AMT, 0, type(uint256).max, SIG);
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
}
