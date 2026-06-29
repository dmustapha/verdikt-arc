// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerdiktEscrow} from "../src/VerdiktEscrow.sol";
import {EscrowFundingHook} from "../src/EscrowFundingHook.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockMessageTransmitter} from "./mocks/MockMessageTransmitter.sol";

contract EscrowFundingHookTest is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;

    VerdiktEscrow escrow;
    EscrowFundingHook hook;
    MockMessageTransmitter transmitter;

    address payer = address(0xA11CE);
    address worker = address(0xB0B);
    address verdictWallet = address(0xDEAD);
    address relayer = address(0x5E1A); // a non-owner, third-party relayer

    bytes32 constant WORK_ID = keccak256("xchain-work-1");
    bytes32 constant EVIDENCE = keccak256("evidence");
    uint256 constant AMT = 5_000000; // 5 USDC
    uint256 constant FEE = 4000; // 0.004 USDC fast-transfer fee

    function setUp() public {
        MockUSDC impl = new MockUSDC();
        vm.etch(USDC, address(impl).code);

        transmitter = new MockMessageTransmitter(USDC);
        escrow = new VerdiktEscrow(verdictWallet);
        // owner of the hook = this test contract (so onlyOwner valves are callable directly).
        hook = new EscrowFundingHook(address(transmitter), USDC, address(escrow), address(this));
        escrow.setHook(address(hook));
    }

    // Build a CCTP-shaped message: 376-byte header/body prefix + abi-encoded hookData.
    // `salt` varies the prefix so two messages with the same hookData hash differently
    // (models distinct CCTP nonces).
    function _message(bytes32 workId, address p, address w, bytes1 salt)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory prefix = new bytes(376);
        prefix[0] = salt;
        return bytes.concat(prefix, abi.encode(workId, p, w));
    }

    function testMintAndFundHappyPath() public {
        transmitter.setMint(AMT);
        hook.mintAndFund(_message(WORK_ID, payer, worker, 0x01), "");

        VerdiktEscrow.Escrow memory e = escrow.getEscrow(WORK_ID);
        assertEq(e.payer, payer);
        assertEq(e.worker, worker);
        assertEq(e.amount, AMT);
        assertEq(e.status, 1); // FUNDED
        assertEq(MockUSDC(USDC).balanceOf(address(escrow)), AMT, "escrow holds principal");
        assertEq(MockUSDC(USDC).balanceOf(address(hook)), 0, "hook drained within the tx");
        assertEq(escrow.totalEscrowed(), AMT);
    }

    // The amount is the MEASURED mint delta (fee-net), never the burned amount.
    function testMintAndFundBalanceDeltaWithFee() public {
        transmitter.setMint(AMT - FEE); // CCTP fast-transfer deducted FEE
        hook.mintAndFund(_message(WORK_ID, payer, worker, 0x01), "");

        VerdiktEscrow.Escrow memory e = escrow.getEscrow(WORK_ID);
        assertEq(e.amount, AMT - FEE, "records the net minted amount");
        assertEq(escrow.totalEscrowed(), AMT - FEE);
    }

    function testMintAndFundDecodesHookData() public {
        address p2 = address(0xCAFE);
        address w2 = address(0xF00D);
        bytes32 id2 = keccak256("other-work");
        transmitter.setMint(AMT);
        hook.mintAndFund(_message(id2, p2, w2, 0x09), "");

        VerdiktEscrow.Escrow memory e = escrow.getEscrow(id2);
        assertEq(e.payer, p2);
        assertEq(e.worker, w2);
        assertEq(e.amount, AMT);
    }

    function testMintAndFundReplayReverts() public {
        transmitter.setMint(AMT);
        bytes memory m = _message(WORK_ID, payer, worker, 0x01);
        hook.mintAndFund(m, "");
        // Same message again -> transmitter rejects the consumed nonce before any mint.
        vm.expectRevert("nonce already used");
        hook.mintAndFund(m, "");
        // Still funded exactly once.
        assertEq(escrow.totalEscrowed(), AMT);
    }

    // A distinct message committing an already-funded workId reverts the WHOLE tx: the mint
    // (and the transmitter's nonce write) roll back, so nothing is stranded in the hook.
    function testMintAndFundWorkIdCollisionRevertsWholeTx() public {
        transmitter.setMint(AMT);
        hook.mintAndFund(_message(WORK_ID, payer, worker, 0x01), "");

        bytes memory m2 = _message(WORK_ID, payer, worker, 0x02); // different bytes, same workId
        vm.expectRevert("workId exists");
        hook.mintAndFund(m2, "");
        assertEq(MockUSDC(USDC).balanceOf(address(hook)), 0, "no USDC stranded; mint rolled back");
    }

    // Permissionless: a third party can relay a valid (message, attestation) and it funds the
    // escrow for the committed params — they only act as a free relayer.
    function testMintAndFundPermissionless() public {
        transmitter.setMint(AMT);
        vm.prank(relayer);
        hook.mintAndFund(_message(WORK_ID, payer, worker, 0x01), "");
        assertEq(escrow.getEscrow(WORK_ID).status, 1);
    }

    function testMintAndFundLengthGuard() public {
        transmitter.setMint(AMT);
        bytes memory short = new bytes(471); // one byte below 376 + 96
        vm.expectRevert("message too short");
        hook.mintAndFund(short, "");
    }

    function testMintAndFundNothingMintedReverts() public {
        transmitter.setMint(0);
        vm.expectRevert("nothing minted");
        hook.mintAndFund(_message(WORK_ID, payer, worker, 0x01), "");
    }

    // ----- owner recovery valves -----

    function testAdminMintThenRescue() public {
        transmitter.setMint(AMT);
        hook.adminMint(_message(WORK_ID, payer, worker, 0x01), ""); // mint into hook, no fund
        assertEq(MockUSDC(USDC).balanceOf(address(hook)), AMT, "minted, not funded");
        assertEq(escrow.getEscrow(WORK_ID).status, 0, "escrow untouched");

        hook.rescue(address(this));
        assertEq(MockUSDC(USDC).balanceOf(address(hook)), 0, "rescued");
    }

    function testAdminFundFromBalance() public {
        MockUSDC(USDC).mint(address(hook), AMT); // USDC already sitting in the hook
        hook.adminFundFromBalance(WORK_ID, payer, worker, AMT);
        VerdiktEscrow.Escrow memory e = escrow.getEscrow(WORK_ID);
        assertEq(e.amount, AMT);
        assertEq(e.status, 1);
    }

    function testAdminMintOnlyOwner() public {
        transmitter.setMint(AMT);
        vm.prank(relayer);
        vm.expectRevert("not owner");
        hook.adminMint(_message(WORK_ID, payer, worker, 0x01), "");
    }

    function testAdminFundFromBalanceOnlyOwner() public {
        MockUSDC(USDC).mint(address(hook), AMT);
        vm.prank(relayer);
        vm.expectRevert("not owner");
        hook.adminFundFromBalance(WORK_ID, payer, worker, AMT);
    }

    function testRescueOnlyOwner() public {
        MockUSDC(USDC).mint(address(hook), AMT);
        vm.prank(relayer);
        vm.expectRevert("not owner");
        hook.rescue(relayer);
    }

    function testRescueNothingReverts() public {
        vm.expectRevert("nothing to rescue");
        hook.rescue(address(this));
    }

    function testTransferOwnership() public {
        hook.transferOwnership(relayer);
        assertEq(hook.owner(), relayer);
    }
}
