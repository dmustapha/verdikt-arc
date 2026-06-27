// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// EIP-3009 transferWithAuthorization (v,r,s overload) — proven on Arc USDC (solv-001).
// The escrow binds the authorization to the task (derived nonce + from=msg.sender),
// so anyone-can-submit is harmless: the funds can only move payer -> escrow for the
// exact (workId, worker, amount) the payer signed.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
