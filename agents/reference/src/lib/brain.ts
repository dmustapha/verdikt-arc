import Anthropic from '@anthropic-ai/sdk';

// The reasoning core for the reference sellers — the same Anthropic SDK + model family the worker's
// verdict arbiter uses, so the whole system speaks one model family. Lazily constructs the client so
// the module is importable (and the harness testable) without a key; the key is only required when a
// seller actually does work.
const MODEL = process.env.REASONER_MODEL ?? 'claude-sonnet-4-6';

export class Brain {
  private client?: Anthropic;

  constructor(private who: string) {}

  private get anthropic(): Anthropic {
    if (!this.client) {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error(`ANTHROPIC_API_KEY required to run the ${this.who} reference seller`);
      this.client = new Anthropic();
    }
    return this.client;
  }

  async say(system: string, prompt: string, maxTokens = 1500): Promise<string> {
    const r = await this.anthropic.messages.create({
      model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }],
    });
    return r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
  }
}
