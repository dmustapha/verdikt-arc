// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// EIP-3009 (v,r,s overload) — proven on Arc USDC. We fund via receiveWithAuthorization, NOT
// transferWithAuthorization: the token enforces `msg.sender == to`, so the escrow is the ONLY
// account that can redeem a payer's signed authorization. A mempool observer who copies the blob
// cannot call the token directly (they are not `to`), which closes the H-1 stranded-funds front-run
// that transferWithAuthorization left open (anyone could push the transfer outside the escrow).
interface IERC3009 {
    function receiveWithAuthorization(
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
