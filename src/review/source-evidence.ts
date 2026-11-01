import { relative, resolve, sep } from "node:path";
import type { ReadEvidence } from "../../base-action/src/read-evidence";

export type ReviewSourceContext = {
  workspace?: string;
  aliases?: Record<string, string>;
  restoredPaths?: string[];
};

/** Normalize real in-workspace paths while rejecting outside citations. */
export function reviewSourcePath(
  path: string,
  context: ReviewSourceContext,
): string | undefined {
  const workspace = context.workspace || process.cwd();
  const local = relative(workspace, resolve(workspace, path))
    .split(sep)
    .join("/");
  if (!local || local === ".." || local.startsWith("../")) return undefined;
  return context.aliases?.[local] || local;
}

/** Bind reads to PR-head contents; restored base files and placeholder snapshots are not head evidence. */
export function sourceWasRead(
  path: string,
  line: number,
  reads: ReadEvidence[],
  context: ReviewSourceContext,
): boolean {
  const target = reviewSourcePath(path, context);
  if (!target) return false;
  return reads.some((read) => {
    const raw = reviewSourcePath(read.path, { workspace: context.workspace });
    if (!raw) return false;
    const alias = context.aliases?.[raw];
    if (
      !alias &&
      (raw.startsWith(".claude-pr/") ||
        context.restoredPaths?.some(
          (restored) => raw === restored || raw.startsWith(`${restored}/`),
        ))
    )
      return false;
    return (
      (alias || raw) === target &&
      read.startLine <= line &&
      read.endLine >= line
    );
  });
}

/** Tell both read-only phases how to inspect preserved PR files without executing their configuration. */
export function snapshotGuidance(context: ReviewSourceContext): string {
  if (!Object.keys(context.aliases || {}).length) return "";
  return `\nPR source snapshots: original sensitive paths now contain trusted BASE configuration. Read the following preserved HEAD snapshots when reviewing those files. Keep finding/citation paths at their original repository paths. Placeholder snapshots do not qualify as source evidence.\n${JSON.stringify(context.aliases).replaceAll("<", "\\u003c")}\n`;
}
