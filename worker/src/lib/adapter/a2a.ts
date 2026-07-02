import { randomUUID } from 'node:crypto';
import { A2AClient } from '@a2a-js/sdk/client';
import type { MessageSendParams, SendMessageResponse, GetTaskResponse } from '@a2a-js/sdk';
import type { SellerTransport } from '../transport.js';
import type { JobRow } from '../job-store.js';
import type { Artifact } from '../../types.js';
import { makeGuardedFetch } from './guarded-fetch.js';
import { parseArtifact } from './normalize.js';

// A2A driver (@a2a-js/sdk). Speaks the open Agent-to-Agent protocol to a seller registered as `a2a`:
//   dispatch     → resolve the agent card at /.well-known/agent-card.json, then message/send a task
//                  envelope (non-blocking). The server returns a Task; we persist its id as the job's
//                  resultRef (via onResultRef) so the keeper/callback can poll it after a restart.
//   fetchResult  → tasks/get the persisted task id; when the task is `completed`, extract the
//                  deliverable from the first DataPart and normalize it to our Artifact. Any other
//                  state (working / failed / not-found) ⇒ null (poller retries; deadline refunds).
// Every HTTP call the SDK makes — the card fetch AND the card's service `url` — flows through a
// guarded fetch, so a malicious card that points its `url` at an internal host is blocked at the
// socket. We never trust a pushed body: the authoritative artifact always comes from tasks/get.
// Robust polling default over push (MASTER-PLAN PART 2): async A2A sellers are polled by task id.

export interface A2ADriverOpts {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  allowPrivate?: boolean;                                     // local mock only
  workerPublicUrl?: string;                                   // for the optional push callback URL in the envelope
  onResultRef?: (jobId: string, ref: string) => Promise<void>; // persist the server-assigned task id
}

// The SDK re-wraps into a JSON-RPC envelope ({ result } | { error }) and throws on transport errors;
// we read `result`/`error` defensively. A2ATask captures only the fields we extract.
type Enveloped = { result?: unknown; error?: { code: number; message: string } };
interface A2ATask { kind?: string; id: string; status?: { state?: string }; artifacts?: Array<{ parts?: Array<{ kind?: string; data?: unknown }> }>; }

export function a2aDriver(opts: A2ADriverOpts = {}): SellerTransport {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const baseFetch = opts.fetchFn ?? fetch;

  function clientFor(base: string): Promise<A2AClient> {
    const guarded = makeGuardedFetch({ fetchFn: baseFetch, timeoutMs, allowedOrigins: [new URL(base).origin], allowPrivate: opts.allowPrivate });
    const cardUrl = new URL('/.well-known/agent-card.json', base).href;
    return A2AClient.fromCardUrl(cardUrl, { fetchImpl: guarded });
  }

  return {
    async dispatch(job: JobRow): Promise<void> {
      if (!job.sellerUrl) throw new Error('a2a job has no sellerUrl to dispatch to');
      const client = await clientFor(job.sellerUrl);
      const envelope = {
        workId: job.workId,
        callbackUrl: `${opts.workerPublicUrl ?? ''}/a2a/callback/${job.jobId}`,
        callbackToken: job.callbackToken,
        deadline: job.deadline.toISOString(),
      };
      const params: MessageSendParams = {
        message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data', data: envelope }] },
        configuration: { blocking: false },
      };
      const resp = (await client.sendMessage(params) as SendMessageResponse) as unknown as Enveloped;
      if (resp.error) throw new Error(`a2a message/send error ${resp.error.code}: ${resp.error.message}`);
      const result = resp.result as A2ATask | undefined;
      if (!result || result.kind !== 'task' || !result.id) {
        // A synchronous Message reply has no task to poll — an async seller MUST return a Task. Throw
        // so the dispatcher records it and the no-show deadline refunds the buyer (documented boundary).
        throw new Error('a2a seller did not return a pollable task (synchronous reply unsupported)');
      }
      if (opts.onResultRef) await opts.onResultRef(job.jobId, result.id);
    },

    async fetchResult(job: JobRow, resultRef?: string): Promise<Artifact | null> {
      const taskId = resultRef ?? job.resultRef ?? undefined;
      if (!taskId || !job.sellerUrl) return null;
      let task: A2ATask | undefined;
      try {
        const client = await clientFor(job.sellerUrl);
        const resp = (await client.getTask({ id: taskId }) as GetTaskResponse) as unknown as Enveloped;
        if (resp.error) return null; // transient / not-found → poller retries, deadline refunds
        task = resp.result as A2ATask | undefined;
      } catch {
        return null; // network / mismatch → not ready
      }
      if (!task || task.status?.state !== 'completed') return null;
      for (const artifact of task.artifacts ?? []) {
        for (const part of artifact.parts ?? []) {
          if (part.kind === 'data') {
            const normalized = parseArtifact(part.data);
            if (normalized) return normalized;
          }
        }
      }
      return null;
    },
  };
}
