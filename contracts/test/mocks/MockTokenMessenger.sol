// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "./MockUSDC.sol";

/// @notice Test double for Circle's TokenMessengerV2 on Arc. depositForBurn pulls (burns) the USDC
///         from the caller (the escrow approved it) and records the destination, so tests can assert
///         the escrow bridged the right amount to the right domain/recipient.
contract MockTokenMessenger {
    address public immutable usdc;
    uint256 public lastAmount;
    uint32 public lastDomain;
    bytes32 public lastRecipient;
    uint256 public burnCount;

    constructor(address _usdc) {
        usdc = _usdc;
    }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address, /*burnToken*/
        bytes32, /*destinationCaller*/
        uint256, /*maxFee*/
        uint32 /*minFinalityThreshold*/
    ) external {
        // Simulate the burn: pull the USDC out of the escrow (which approved us).
        MockUSDC(usdc).transferFrom(msg.sender, address(this), amount);
        lastAmount = amount;
        lastDomain = destinationDomain;
        lastRecipient = mintRecipient;
        burnCount++;
    }
}
