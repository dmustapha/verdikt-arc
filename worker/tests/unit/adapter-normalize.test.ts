import { describe, it, expect } from 'vitest';
import { parseArtifact, extractArtifact } from '../../src/lib/adapter/normalize.js';

// The single normalization source (Gate C2: every driver yields an identical {status,artifact}).
// parseArtifact validates a raw candidate; extractArtifact also unwraps the common `{ artifact: … }`
// envelope (webhook GET / x402 job-URL / A2A DataPart bodies all pass through the same gate).

describe('parseArtifact', () => {
  it('accepts each valid ArtifactType with a non-empty payload', () => {
    for (const type of ['code', 'tool_output', 'answer', 'execution', 'tool_trace'] as const) {
      expect(parseArtifact({ type, payload: 'x' })).toEqual({ type, payload: 'x' });
    }
  });

  it('passes through a valid code language, drops an unknown one', () => {
    expect(parseArtifact({ type: 'code', payload: 'print(1)', language: 'python' }))
      .toEqual({ type: 'code', payload: 'print(1)', language: 'python' });
    expect(parseArtifact({ type: 'code', payload: 'print(1)', language: 'ruby' }))
      .toEqual({ type: 'code', payload: 'print(1)' });
  });

  it('rejects an unknown type, empty/blank payload, or non-object', () => {
    expect(parseArtifact({ type: 'nonsense', payload: 'x' })).toBeNull();
    expect(parseArtifact({ type: 'answer', payload: '' })).toBeNull();
    expect(parseArtifact({ type: 'answer', payload: '   ' })).toBeNull();
    expect(parseArtifact({ type: 'answer' })).toBeNull();
    expect(parseArtifact(null)).toBeNull();
    expect(parseArtifact('answer')).toBeNull();
  });
});

describe('extractArtifact', () => {
  it('unwraps a { artifact: … } envelope', () => {
    const artifact = { type: 'answer', payload: 'the answer' };
    expect(extractArtifact({ artifact })).toEqual(artifact);
  });

  it('accepts a bare artifact', () => {
    expect(extractArtifact({ type: 'code', payload: 'print(1)', language: 'python' }))
      .toEqual({ type: 'code', payload: 'print(1)', language: 'python' });
  });

  it('returns null for a malformed body', () => {
    expect(extractArtifact({ artifact: { type: 'x', payload: '' } })).toBeNull();
    expect(extractArtifact(null)).toBeNull();
  });
});
