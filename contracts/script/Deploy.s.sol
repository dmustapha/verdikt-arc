// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VerdiktEscrow} from "../src/VerdiktEscrow.sol";
import {EscrowFundingHook} from "../src/EscrowFundingHook.sol";

contract Deploy is Script {
    // Arc testnet fixed addresses (CCTP V2 + USDC predeploy).
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant ARC_MESSAGE_TRANSMITTER = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verdictWallet = vm.envAddress("VERDICT_WALLET_ADDRESS"); // Circle DCW settlement wallet
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        // 1. Escrow (owner = deployer, verdict = settlement wallet).
        VerdiktEscrow escrow = new VerdiktEscrow(verdictWallet);
        // 2. Cross-chain funding hook (owner = deployer; immutable transmitter/usdc/escrow).
        EscrowFundingHook hook =
            new EscrowFundingHook(ARC_MESSAGE_TRANSMITTER, USDC, address(escrow), deployer);
        // 3. Authorize the hook on the escrow.
        escrow.setHook(address(hook));
        vm.stopBroadcast();

        console.log("VerdiktEscrow:", address(escrow));
        console.log("EscrowFundingHook:", address(hook));
        console.log("verdict wallet:", verdictWallet);
        console.log("deployer/owner:", deployer);
    }
}
