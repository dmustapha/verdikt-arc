import Anthropic from '@anthropic-ai/sdk';

// The reasoning core shared by both agents. Same Anthropic SDK + model the worker's arbiter uses, so
// the whole system speaks one model family. `decide()` forces a tool call for structured output (no
// brittle JSON-in-prose parsing); `say()` is free-form when we just want prose.
const MODEL = process.env.REASONER_MODEL ?? 'claude-sonnet-4-6';

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export class Brain {
  private client: Anthropic;

  constructor(private who: string) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required to run the agents');
    this.client = new Anthropic();
  }

  async say(system: string, prompt: string): Promise<string> {
    const r = await this.client.messages.create({
      model: MODEL, max_tokens: 1500, system, messages: [{ role: 'user', content: prompt }],
    });
    return r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
  }

  // Force the model to call `tool` and return its validated input as T.
  async decide<T>(system: string, prompt: string, tool: ToolSpec): Promise<T> {
    const r = await this.client.messages.create({
      model: MODEL, max_tokens: 2000, system,
      tools: [tool], tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: prompt }],
    });
    const use = r.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!use) throw new Error(`${this.who}: model did not call ${tool.name}`);
    return use.input as T;
  }
}
