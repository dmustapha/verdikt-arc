import type { Acceptance, Artifact, EvidenceBundle, EvidenceItem } from '../types.js';
import { readerClient, isChainConfigured } from '../lib/exec-chains.js';

// The execution route verifies a claimed ON-CHAIN EFFECT. The artifact is a tx hash; the verifier
// reads the receipt (+ tx) from the declared chain and checks it deterministically against the
// payer's ExecutionCriteria. This is ground truth — a mined receipt is immutable, so the same
// artifact always yields the same verdict. Scope is the on-chain slice ONLY (we do not verify
// arbitrary Web2 side effects); an unconfigured chain abstains rather than releasing on a claim we
// cannot read.

// The minimal on-chain facts the route needs, so it can be unit-tested with an injected reader.
export interface ExecTx {
  status: 'success' | 'reverted';
  from: `0x${string}`;
  to: `0x${string}` | null;
  valueWei: bigint;
  logs: { address: `0x${string}`; topics: readonly `0x${string}`[] }[];
}
export interface ChainReader {
  read(chainId: number, txHash: `0x${string}`): Promise<ExecTx | null>; // null = no receipt (unmined/absent)
}

const TXHASH = /^0x[0-9a-fA-F]{64}$/;

function ev(id: string, label: string, passed: boolean, detail: string, ref?: string): EvidenceItem {
  return { id: `exec:${id}`, kind: 'onchain', label, status: passed ? 'pass' : 'fail', detail, ref };
}

// Default reader: real chain reads via viem. Not-found → null (a fail, not an error); any other RPC
// failure throws → the route surfaces a routeError → abstain.
export const viemReader: ChainReader = {
  async read(chainId, txHash) {
    const client = readerClient(chainId);
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash });
    } catch (e) {
      if (e instanceof Error && /not be found|not found|receipt/i.test(e.message)) return null;
      throw e;
    }
    const tx = await client.getTransaction({ hash: txHash });
    return {
      status: receipt.status,
      from: receipt.from,
      to: receipt.to,
      valueWei: tx.value,
      logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics })),
    };
  },
};

export async function runExecutionRoute(
  acceptance: Acceptance,
  artifact: Artifact,
  reader: ChainReader = viemReader,
): Promise<EvidenceBundle> {
  const crit = acceptance.execution;
  if (!crit || typeof crit.chainId !== 'number') {
    return { route: 'execution', items: [], routeError: 'payer provided no execution criteria (chainId)' };
  }

  const hash = artifact.payload.trim();
  // A malformed claim is garbage → a hard fail (refund), never a release. (Distinct from an
  // unreadable chain, which abstains: here the seller's artifact itself is not a tx hash.)
  if (!TXHASH.test(hash)) {
    return { route: 'execution', items: [ev('tx_hash', 'Tx Hash', false, 'artifact is not a 32-byte tx hash')] };
  }
  const txHash = hash as `0x${string}`;

  if (!isChainConfigured(crit.chainId)) {
    return { route: 'execution', items: [], routeError: `chain ${crit.chainId} not supported by the execution verifier` };
  }

  let tx: ExecTx | null;
  try {
    tx = await reader.read(crit.chainId, txHash);
  } catch (e) {
    return { route: 'execution', items: [], routeError: `chain read failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` };
  }

  // No receipt = the claimed effect is unsubstantiated → fail (refund), never release.
  if (!tx) {
    return { route: 'execution', items: [ev('tx_found', 'Tx Found', false, `no receipt for ${txHash} on chain ${crit.chainId} (unsubstantiated)`, txHash)] };
  }

  const items: EvidenceItem[] = [ev('tx_found', 'Tx Found', true, `receipt present on chain ${crit.chainId}`, txHash)];

  const wantStatus = crit.status ?? 'success';
  items.push(ev('status', 'Tx Status', tx.status === wantStatus, `status=${tx.status}, expected ${wantStatus}`));

  if (crit.to) {
    const ok = !!tx.to && tx.to.toLowerCase() === crit.to.toLowerCase();
    items.push(ev('to', 'Called Contract', ok, `to=${tx.to ?? 'null'}, expected ${crit.to}`));
  }
  if (crit.from) {
    const ok = tx.from.toLowerCase() === crit.from.toLowerCase();
    items.push(ev('from', 'Sender', ok, `from=${tx.from}, expected ${crit.from}`));
  }
  if (crit.minValueWei) {
    let ok = false;
    try { ok = tx.valueWei >= BigInt(crit.minValueWei); } catch { ok = false; }
    items.push(ev('value', 'Value', ok, `value=${tx.valueWei} wei, min ${crit.minValueWei}`));
  }
  if (crit.log) {
    const t0 = crit.log.topic0.toLowerCase();
    const addr = crit.log.address?.toLowerCase();
    const want = crit.log.topics;
    const match = tx.logs.some((l) => {
      if (l.topics.length === 0 || l.topics[0].toLowerCase() !== t0) return false;
      if (addr && l.address.toLowerCase() !== addr) return false;
      if (want) {
        for (let i = 0; i < want.length; i++) {
          const w = want[i];
          if (w == null) continue;                         // wildcard
          if (!l.topics[i] || l.topics[i].toLowerCase() !== w.toLowerCase()) return false;
        }
      }
      return true;
    });
    items.push(ev('log', 'Event Emitted', match, match ? `matched topic0 ${t0}` : `no log matching topic0 ${t0}${addr ? ` @ ${addr}` : ''}`));
  }

  return { route: 'execution', items };
}
