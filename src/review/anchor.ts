import type { Finding } from "./schema";

export type ChangedReviewFile = {
  filename: string;
  previous_filename?: string;
  patch?: string;
};
export type ReviewAnchor = {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
};

/** Select one real diff line for the grouped discussion, preferring its primary finding. */
export function findReviewAnchor(
  files: ChangedReviewFile[],
  findings: Finding[],
): ReviewAnchor | undefined {
  const severity = { bug: 0, suggestion: 1, pre_existing: 2 };
  const ranked = [...findings].sort(
    (a, b) => severity[a.severity] - severity[b.severity],
  );
  const key = (path: string, side: string, line: number) =>
    `${path}\0${side}\0${line}`;
  const wanted = new Map<string, number>();
  ranked.forEach((finding, index) => {
    const position = key(finding.path, finding.side, finding.line);
    if (!wanted.has(position)) wanted.set(position, index);
  });
  let best: ReviewAnchor | undefined;
  let bestRank = Infinity;
  let firstAdded: ReviewAnchor | undefined;
  let firstRemoved: ReviewAnchor | undefined;
  let firstContext: ReviewAnchor | undefined;
  for (const file of files) {
    let oldLine = 0,
      newLine = 0,
      oldLeft = 0,
      newLeft = 0;
    const consider = (
      side: "LEFT" | "RIGHT",
      line: number,
      changed: boolean,
    ) => {
      if (line < 1) return;
      const anchor = { path: file.filename, line, side };
      if (changed && side === "RIGHT") firstAdded ??= anchor;
      else if (changed) firstRemoved ??= anchor;
      else firstContext ??= anchor;
      const rank =
        wanted.get(key(file.filename, side, line)) ??
        (side === "LEFT" && file.previous_filename
          ? wanted.get(key(file.previous_filename, side, line))
          : undefined);
      if (rank !== undefined && rank < bestRank) {
        best = anchor;
        bestRank = rank;
      }
    };
    for (const line of (file.patch ?? "").split("\n")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        oldLeft = Number(hunk[2] ?? 1);
        newLine = Number(hunk[3]);
        newLeft = Number(hunk[4] ?? 1);
        continue;
      }
      if (line.startsWith("+") && newLeft > 0) {
        consider("RIGHT", newLine++, true);
        newLeft--;
      } else if (line.startsWith("-") && oldLeft > 0) {
        consider("LEFT", oldLine++, true);
        oldLeft--;
      } else if (line.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
        consider("RIGHT", newLine++, false);
        consider("LEFT", oldLine++, false);
        oldLeft--;
        newLeft--;
      }
      if (bestRank === 0) return best;
    }
  }
  return best ?? firstAdded ?? firstRemoved ?? firstContext;
}
