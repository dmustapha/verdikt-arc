// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerdiktEscrow} from "../src/VerdiktEscrow.sol";

// A USDC mock that ENFORCES receiveWithAuthorization's `msg.sender == to` rule (EIP-3009). This is
// the exact property that closes the H-1 front-run: only the payee (the escrow) can redeem a payer's
// signed authorization, so a mempool observer cannot strand funds by pushing the transfer outside
// the escrow.
contract ReceiveEnforcingUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => bool) public usedNonce;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "insufficient");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256, uint256, bytes32 nonce, uint8, bytes32, bytes32
    ) external {
        require(msg.sender == to, "caller must be the payee"); // <- the EIP-3009 receive rule
        require(!usedNonce[nonce], "authorization used");
        require(balanceOf[from] >= value, "insufficient");
        usedNonce[nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

contract FrontrunResistanceTest is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    VerdiktEscrow escrow;

    address payer = address(0xA11CE);
    address worker = address(0xB0B);
    address verdictWallet = address(0xDEAD);
    address attacker = address(0xBAD);

    bytes constant SIG = hex"11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222" hex"1b";
    bytes32 constant WORK_ID = keccak256("fr-1");
    uint256 constant AMT = 5_000000;

    function setUp() public {
        ReceiveEnforcingUSDC impl = new ReceiveEnforcingUSDC();
        vm.etch(USDC, address(impl).code);
        ReceiveEnforcingUSDC(USDC).mint(payer, 100_000000);
        escrow = new VerdiktEscrow(verdictWallet);
    }

    // The escrow (msg.sender == to) CAN redeem the authorization and records the escrow atomically.
    function testEscrowCanFundViaReceiveAuth() public {
        vm.prank(payer);
        escrow.fundWithAuthorization(WORK_ID, worker, AMT, 0, type(uint256).max, SIG);
        assertEq(ReceiveEnforcingUSDC(USDC).balanceOf(address(escrow)), AMT);
        assertEq(escrow.getEscrow(WORK_ID).status, 1); // FUNDED
        assertEq(escrow.totalEscrowed(), AMT);
    }

    // H-1: a front-runner who copies the payer's signed blob CANNOT push the transfer by calling the
    // token directly — receiveWithAuthorization requires msg.sender == to (the escrow). No stranded
    // funds, no orphaned authorization; the escrow can still fund normally afterwards.
    function testFrontrunnerDirectTokenCallReverts() public {
        bytes32 nonce = keccak256(abi.encode(WORK_ID, worker, AMT, payer));
        vm.prank(attacker);
        vm.expectRevert("caller must be the payee");
        ReceiveEnforcingUSDC(USDC).receiveWithAuthorization(
            payer, address(escrow), AMT, 0, type(uint256).max, nonce, 27, bytes32(0), bytes32(0)
        );

        // The authorization is still unused → the legitimate fund path works and no funds were
        // stranded in the escrow without a record.
        assertEq(ReceiveEnforcingUSDC(USDC).balanceOf(address(escrow)), 0, "nothing stranded");
        vm.prank(payer);
        escrow.fundWithAuthorization(WORK_ID, worker, AMT, 0, type(uint256).max, SIG);
        assertEq(escrow.getEscrow(WORK_ID).status, 1, "fund still works after a failed front-run");
    }
}
