// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VerdiktEscrow} from "../src/VerdiktEscrow.sol";

contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verdictWallet = vm.envAddress("VERDICT_WALLET_ADDRESS"); // Circle DCW settlement wallet
        vm.startBroadcast(pk);
        VerdiktEscrow escrow = new VerdiktEscrow(verdictWallet);
        vm.stopBroadcast();
        console.log("VerdiktEscrow:", address(escrow));
        console.log("verdict wallet:", verdictWallet);
    }
}
