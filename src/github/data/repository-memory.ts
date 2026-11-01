import { z } from "zod";
import { redactSecrets, sanitizeContent } from "../utils/sanitizer";

export const REPOSITORY_MEMORY_BRANCH = "codex/review-memory";
export const REPOSITORY_MEMORY_BYTES = 2000;
export const repositoryLearningSchema = z.strictObject({
  paths: z
    .array(z.string().min(1).max(240))
    .min(1)
    .max(5)
    .describe("Changed file paths or directory prefixes ending in /"),
  note: z
    .string()
    .trim()
    .min(1)
    .max(700)
    .describe(
      "One reusable invariant or test location, never current-PR findings or secrets",
    ),
});
export const repositoryRecordSchema = repositoryLearningSchema.extend({
  version: z.literal(1),
  sourcePr: z.number().int().positive(),
  head: z.string().regex(/^[0-9a-f]{40,64}$/i),
});
export type RepositoryLearning = z.infer<typeof repositoryLearningSchema>;
export type RepositoryMemoryRecord = z.infer<typeof repositoryRecordSchema>;
export type RepositoryMemoryContext = {
  records: RepositoryMemoryRecord[];
  status: string;
};

/** Accept literal relative paths, never glob patterns, traversal or Git internals. */
export function validMemoryPaths(paths: string[]): boolean {
  return paths.every(
    (path) =>
      !path.startsWith("/") &&
      !/[\\\x00-\x1f*?\[\]]/.test(path) &&
      !path
        .split("/")
        .some(
          (part, index, parts) =>
            [".", "..", ".git"].includes(part) ||
            (!part && index !== parts.length - 1),
        ),
  );
}

/** Decode then redact notes, preserving UTF-8 boundaries within the storage budget. */
export function cleanMemoryNote(note: string): string {
  const clean = redactSecrets(sanitizeContent(note)).trim();
  if (Buffer.byteLength(clean) <= 700) return clean;
  const suffix = "\n[truncated]";
  let result = "",
    bytes = Buffer.byteLength(suffix);
  for (const character of clean) {
    bytes += Buffer.byteLength(character);
    if (bytes > 700) break;
    result += character;
  }
  return result + suffix;
}

/** Parse the one record schema shared by model output, artifacts and branch storage. */
export function parseMemoryRecord(
  body: string,
): RepositoryMemoryRecord | undefined {
  if (Buffer.byteLength(body) > 8000) return undefined;
  try {
    const parsed = repositoryRecordSchema.safeParse(JSON.parse(body));
    if (!parsed.success || !validMemoryPaths(parsed.data.paths))
      return undefined;
    const note = cleanMemoryNote(parsed.data.note);
    return note
      ? {
          version: 1,
          sourcePr: parsed.data.sourcePr,
          head: parsed.data.head,
          paths: parsed.data.paths,
          note,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Rank exact file matches above directory matches without loading unrelated notes. */
export function memoryRelevance(
  record: Pick<RepositoryMemoryRecord, "paths">,
  changedPaths: string[],
): number {
  return changedPaths.reduce(
    (score, path) =>
      score +
      record.paths.reduce(
        (matches, scope) =>
          matches +
          (scope === path
            ? 2
            : scope.endsWith("/") && path.startsWith(scope)
              ? 1
              : 0),
        0,
      ),
    0,
  );
}

/** Limit prompt context while retaining the full indexed store outside the model. */
export function boundRepositoryMemory(
  records: RepositoryMemoryRecord[],
): RepositoryMemoryRecord[] {
  const selected: RepositoryMemoryRecord[] = [];
  for (const record of records) {
    if (
      Buffer.byteLength(JSON.stringify([...selected, record])) <=
      REPOSITORY_MEMORY_BYTES
    )
      selected.push(record);
    if (selected.length === 3) break;
  }
  return selected;
}
