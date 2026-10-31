/** Escape text used inside publisher-owned HTML, including attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

/** GitHub-supported disclosure with a text-only summary. Callers own body content. */
export function renderDetails(
  summary: string,
  body: string,
  open = false,
): string {
  const label = escapeHtml(summary);
  return `<details${open ? " open" : ""}>\n<summary>${label}</summary>\n\n${body.trim()}\n\n</details>`;
}
