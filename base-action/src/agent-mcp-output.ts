/** Conservatively bound tokens by UTF-8 bytes without guessing a model tokenizer. */
export function boundMcpOutput(output: string, limit: number): string {
  if (Buffer.byteLength(output) <= limit) return output;
  const suffix = "\n[MCP output truncated]";
  const budget = Math.max(0, limit - Buffer.byteLength(suffix));
  let prefix = "",
    bytes = 0;
  for (const character of output) {
    bytes += Buffer.byteLength(character);
    if (bytes > budget) break;
    prefix += character;
  }
  return budget ? prefix + suffix : "…".slice(0, limit < 3 ? 0 : 1);
}
