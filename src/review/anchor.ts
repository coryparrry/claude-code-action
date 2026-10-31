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

/** Accept only the finding's actual line in the PR patch; never move it to unrelated code. */
export function findReviewAnchor(
  files: ChangedReviewFile[],
  finding: Pick<Finding, "path" | "line" | "side">,
): ReviewAnchor | undefined {
  for (const file of files) {
    if (
      file.filename !== finding.path &&
      !(finding.side === "LEFT" && file.previous_filename === finding.path)
    )
      continue;
    let oldLine = 0,
      newLine = 0,
      oldLeft = 0,
      newLeft = 0;
    for (const line of (file.patch ?? "").split("\n")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        oldLeft = Number(hunk[2] ?? 1);
        newLine = Number(hunk[3]);
        newLeft = Number(hunk[4] ?? 1);
        continue;
      }
      let left: number | undefined, right: number | undefined;
      if (line.startsWith("+") && newLeft > 0) {
        right = newLine++;
        newLeft--;
      } else if (line.startsWith("-") && oldLeft > 0) {
        left = oldLine++;
        oldLeft--;
      } else if (line.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
        left = oldLine++;
        right = newLine++;
        oldLeft--;
        newLeft--;
      }
      const actual = finding.side === "LEFT" ? left : right;
      if (actual !== undefined && actual > 0 && actual === finding.line)
        return { path: file.filename, line: actual, side: finding.side };
    }
  }
  return undefined;
}
