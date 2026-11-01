/** Normalize labels; absent labels must normalize to the empty string. */
export function normalizeLabel(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}
