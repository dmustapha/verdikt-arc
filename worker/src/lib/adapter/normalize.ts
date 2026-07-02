import type { Artifact, ArtifactType } from '../../types.js';

// The single artifact-normalization source for the generic seller adapter (WS4). Every driver — the
// signed-webhook GET re-fetch, the A2A DataPart, the x402 job-URL body — funnels its raw delivery
// through here so all three yield an IDENTICAL Artifact (Gate C2: "each normalizes to the same
// {status,artifact}"). Kept dependency-free so it can never disagree with itself across drivers.

const ARTIFACT_TYPES: ArtifactType[] = ['code', 'tool_output', 'answer', 'execution', 'tool_trace'];

// Validate a RAW candidate into a well-formed Artifact, or null. Rejects unknown types and
// empty/blank payloads; keeps only a recognized code `language`.
export function parseArtifact(v: unknown): Artifact | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  if (!ARTIFACT_TYPES.includes(a.type as ArtifactType)) return null;
  if (typeof a.payload !== 'string' || a.payload.trim() === '') return null;
  const art: Artifact = { type: a.type as ArtifactType, payload: a.payload };
  if (a.language === 'python' || a.language === 'typescript') art.language = a.language;
  return art;
}

// Extract an artifact from a delivery body that may wrap it under `artifact` or return it bare.
export function extractArtifact(body: unknown): Artifact | null {
  const candidate = body && typeof body === 'object' && 'artifact' in body
    ? (body as Record<string, unknown>).artifact
    : body;
  return parseArtifact(candidate);
}
