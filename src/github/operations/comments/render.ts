/** GitHub-supported disclosure with a text-only summary. Callers own body content. */
export function renderDetails(
  summary: string,
  body: string,
  open = false,
): string {
  const label = summary.replace(
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
  return `<details${open ? " open" : ""}>\n<summary>${label}</summary>\n\n${body.trim()}\n\n</details>`;
}
