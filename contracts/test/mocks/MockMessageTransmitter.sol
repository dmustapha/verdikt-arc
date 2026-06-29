// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "./MockUSDC.sol";

/// @notice Test double for Circle's MessageTransmitterV2. On receiveMessage it mints a configured
///         amount of MockUSDC to the caller (the hook), mirroring CCTP's "mint to mintRecipient"
///         effect, and reverts on a replayed message (mirroring CCTP's per-nonce replay guard).
///         The configurable mintAmount lets tests model the Fast-Transfer fee (mint < burn).
contract MockMessageTransmitter {
    address public immutable usdc;
    uint256 public mintAmount;
    mapping(bytes32 => bool) public usedMessage;

    constructor(address _usdc) {
        usdc = _usdc;
    }

    /// @notice Set the USDC amount the next receiveMessage will mint to the caller (fee-net amount).
    function setMint(uint256 amount) external {
        mintAmount = amount;
    }

    function receiveMessage(bytes calldata message, bytes calldata /*attestation*/)
        external
        returns (bool)
    {
        bytes32 k = keccak256(message);
        require(!usedMessage[k], "nonce already used"); // CCTP replay protection
        usedMessage[k] = true;
        MockUSDC(usdc).mint(msg.sender, mintAmount);
        return true;
    }
}
