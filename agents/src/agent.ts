import { Verdikt } from '@verdikt/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { Brain } from './brain.js';

// The general agent abstraction. An agent is a wallet + a Verdikt client + an LLM brain, playing a
// role. PayerAgent and SellerAgent are the two roles a Verdikt transaction needs today; new agent
// types (auditor, broker, multi-route specialists) extend this same shape — Verdikt never does the
// work itself, it just settles between whatever agents show up.
export abstract class Agent {
  readonly address: `0x${string}`;
  protected vk: Verdikt;
  protected brain: Brain;

  constructor(public readonly role: string, endpoint: string, rpcUrl: string | undefined, key: `0x${string}`) {
    this.address = privateKeyToAccount(key).address;
    this.vk = new Verdikt({ endpoint, rpcUrl, signer: { privateKey: key } });
    this.brain = new Brain(role);
  }
}
