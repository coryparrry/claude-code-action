import { relative, resolve, sep } from "node:path";
import type { AgentToolEvent } from "./agent-tools";

export type ReadEvidence = { path: string; startLine: number; endLine: number };

/** Record only successful text returned by Read, using the tool's actual line-numbered output. */
export function readEvidence(
  event: AgentToolEvent,
  workspace: string,
): ReadEvidence | undefined {
  if (
    event.name !== "Read" ||
    event.error ||
    typeof event.input.file_path !== "string" ||
    typeof event.output !== "string"
  )
    return undefined;
  const path = relative(workspace, resolve(workspace, event.input.file_path))
    .split(sep)
    .join("/");
  if (!path || path === ".." || path.startsWith("../")) return undefined;
  const returned = event.output.endsWith("\n[output truncated]")
    ? event.output
        .slice(0, -"\n[output truncated]".length)
        .split("\n")
        .slice(0, -1)
    : event.output.split("\n");
  const lines = returned
    .map((line) => /^(\d+)\t/.exec(line)?.[1])
    .filter((line): line is string => line !== undefined)
    .map(Number);
  if (!lines.length) return undefined;
  return { path, startLine: lines[0]!, endLine: lines.at(-1)! };
}
