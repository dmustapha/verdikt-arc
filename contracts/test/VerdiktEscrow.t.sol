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
        escrow.settle(WORK_ID, 0, 0, EVIDENCE); // release, pass
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
        escrow.settle(WORK_ID, 1, 1, EVIDENCE); // refund, fail
        assertEq(MockUSDC(USDC).balanceOf(payer), before + AMT);
    }

    function testAbstainRefundsToPayer() public {
        _fund();
        uint256 before = MockUSDC(USDC).balanceOf(payer);
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 2, 3, EVIDENCE); // abstain-default, abstain
        assertEq(MockUSDC(USDC).balanceOf(payer), before + AMT);
    }

    function testOnlyVerdictCanSettle() public {
        _fund();
        vm.prank(payer);
        vm.expectRevert("not verdict");
        escrow.settle(WORK_ID, 0, 0, EVIDENCE);
    }

    function testCannotDoubleSettle() public {
        _fund();
        vm.prank(verdictWallet);
        escrow.settle(WORK_ID, 0, 0, EVIDENCE);
        vm.prank(verdictWallet);
        vm.expectRevert("not funded");
        escrow.settle(WORK_ID, 1, 1, EVIDENCE);
    }

    function testBadOutcomeReverts() public {
        _fund();
        vm.prank(verdictWallet);
        vm.expectRevert("bad outcome");
        escrow.settle(WORK_ID, 3, 0, EVIDENCE);
    }
}
