// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal USDC mock for unit tests. transferWithAuthorization ignores the
// signature (signature verification is the real token's job) and just moves
// balance from -> to, mirroring the real token's post-verification effect.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "insufficient");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferWithAuthorization(
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
}
