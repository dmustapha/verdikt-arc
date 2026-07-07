import Anthropic from '@anthropic-ai/sdk';

// One tool-calling seam for the whole engine. Every reasoning call (verdict, grounding, NLI) forces a
// single tool and reads back its structured input. The PROVIDER is pluggable: Anthropic native, or any
// OpenAI-compatible endpoint (Groq, OpenRouter). The deterministic floor decides every fail/refund
// WITHOUT the model — the model is only consulted to certify a pass over a clean bundle — so the reasoner
// is swappable without weakening the trust guarantee. Errors/no-output propagate as throw/null and the
// callers fail safe (abstain / routeError), never a fabricated pass.

export interface ToolSpec {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface CallToolArgs {
  /** system prompt (optional) */
  system?: string;
  /** the user message content */
  userContent: string;
  /** the single tool the model is forced to call */
  tool: ToolSpec;
  maxTokens?: number;
  /** per-call model override (rare); defaults to the provider's configured model */
  model?: string;
}

const PROVIDER = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
const ANTHROPIC_MODEL = process.env.REASONER_MODEL ?? 'claude-sonnet-4-6';

// OpenAI-compatible (Groq default). Override via env for OpenRouter etc.
const OAI_BASE = (process.env.LLM_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const OAI_KEY = process.env.LLM_API_KEY ?? process.env.GROQ_API_KEY ?? '';
const OAI_MODEL = process.env.LLM_MODEL ?? 'llama-3.3-70b-versatile';

/**
 * Force the given tool and return its parsed input object, or null if the model emitted no tool call.
 * Throws on transport/API error (callers translate a throw into a safe abstain/routeError).
 */
export async function callTool(args: CallToolArgs): Promise<Record<string, unknown> | null> {
  if (PROVIDER === 'anthropic') return callAnthropic(args);
  return callOpenAICompatible(args);
}

async function callAnthropic({ system, userContent, tool, maxTokens = 1024, model }: CallToolArgs) {
  // Route through global fetch: the SDK's bundled HTTP layer "Premature close"-es on tool_use responses
  // inside the Fly VM, while global undici fetch works. Verified on the deployed host.
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, fetch: (...a) => globalThis.fetch(...a) });
  const res = await client.messages.create({
    model: model ?? ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    tool_choice: { type: 'tool', name: tool.name },
    tools: [{ name: tool.name, description: tool.description, input_schema: tool.input_schema } as never],
    messages: [{ role: 'user', content: userContent }],
  });
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') return null;
  return block.input as Record<string, unknown>;
}

async function callOpenAICompatible({ system, userContent, tool, maxTokens = 1024 }: CallToolArgs) {
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userContent });

  const body = {
    model: OAI_MODEL,
    max_tokens: maxTokens,
    temperature: 0, // deterministic-as-possible: this is a judge, not a writer
    messages,
    tools: [{ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.input_schema } }],
    tool_choice: { type: 'function', function: { name: tool.name } },
  };

  const res = await globalThis.fetch(`${OAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OAI_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM ${OAI_BASE} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
  };
  const raw = data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // malformed tool args → caller fails safe
  }
}
