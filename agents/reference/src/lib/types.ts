// The Verdikt seller-facing contract (mirrors the worker's SellerBrief + Artifact + dispatch envelope).
// Kept as a small local copy so a reference seller is a self-contained deployable with no worker import.

export type Route = 'answer' | 'tool_output' | 'code';

// The route-filtered input the worker sends (Option C): exactly what the seller needs to do the work.
export interface Brief {
  type: Route;
  spec: string;                                  // the task / question
  sources?: string;                              // answer route: text to ground in
  schema?: Record<string, unknown>;              // tool_output route: target field map
  jsonSchema?: Record<string, unknown>;          // tool_output route: full JSON Schema
  tests?: string;                                // code route (fair mode): the failing test to make pass
}

// The deliverable the seller produces and POSTs back to the worker's callback.
export interface Artifact {
  type: Route;
  payload: string;                               // answer text / JSON string / code source
  language?: 'python' | 'typescript';            // code route only
}

// What the worker POSTs to the seller on dispatch.
export interface DispatchEnvelope {
  workId: string;
  brief: Brief | null;
  callbackUrl: string;                           // where to POST the finished artifact
  callbackToken: string;                         // per-job bearer proving we were the dispatched seller
  deadline: string;                              // ISO — deliver before this or the buyer is refunded
}
