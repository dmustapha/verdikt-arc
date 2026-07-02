// Models sometimes wrap code/JSON in ```fences``` despite instructions to output raw text. Strip a
// single surrounding fence so the payload is the bare source/JSON the worker's verifier parses.
export function stripFences(s: string): string {
  const t = s.trim();
  const m = /^```[a-zA-Z0-9]*\s*([\s\S]*?)\s*```$/.exec(t);
  return (m ? m[1] : t).trim();
}
