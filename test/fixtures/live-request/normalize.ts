/** Normalize surrounding whitespace, treating absent input as an empty label. */
export function normalizeLabel(value: string | null): string {
  return value?.trim() ?? "";
}
