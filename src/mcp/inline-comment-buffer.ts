import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Each action invocation owns a fresh buffer, including repeated steps. */
export function initializeInlineCommentBuffer(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const directory = mkdtempSync(
    join(env.RUNNER_TEMP || tmpdir(), "codex-inline-comments-"),
  );
  const path = join(directory, "comments.jsonl");
  writeFileSync(path, "", { mode: 0o600 });
  return path;
}

export function getInlineCommentBufferPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.CODEX_INLINE_COMMENTS_BUFFER || undefined;
}

export type BufferedCommentMatch = {
  path: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  commit_id?: string;
  body: string;
};

/**
 * Remove any buffered inline comment that matches an already-posted comment.
 *
 * When a comment is posted live (confirmed=true), an earlier buffered copy of
 * the same comment must be dropped so the post-session replay step does not
 * post it a second time. The model frequently re-issues a buffered call with
 * confirmed=true after reading the "Set confirmed=true to post immediately"
 * reply; previously the original buffered entry was left behind and replayed,
 * producing duplicate inline comments.
 *
 * Entries are matched on path, line, startLine, side, commit and body. Lines that cannot be
 * parsed are kept untouched.
 */
export function removeBufferedComment(
  match: BufferedCommentMatch,
  bufferPath: string,
): void {
  if (!existsSync(bufferPath)) {
    return;
  }

  const remaining = readFileSync(bufferPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      let entry: BufferedCommentMatch;
      try {
        entry = JSON.parse(line);
      } catch {
        // Keep anything we cannot parse rather than silently dropping it.
        return true;
      }
      const isSameComment =
        entry.path === match.path &&
        entry.line === match.line &&
        entry.startLine === match.startLine &&
        (entry.side || "RIGHT") === (match.side || "RIGHT") &&
        entry.commit_id === match.commit_id &&
        entry.body === match.body;
      return !isSameComment;
    });

  writeFileSync(
    bufferPath,
    remaining.length > 0 ? remaining.join("\n") + "\n" : "",
  );
}
