import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanMemoryNote,
  parseMemoryRecord,
  validMemoryPaths,
  type RepositoryMemoryRecord,
} from "./repository-memory";

export type ReviewMemoryCandidate = {
  version: 1;
  repository: string;
  runId: number;
  record: RepositoryMemoryRecord;
};

/** Decode a small candidate manifest; provenance remains untrusted until publisher validation. */
export function parseReviewCandidate(body: string): ReviewMemoryCandidate {
  if (Buffer.byteLength(body) > 8000)
    throw new Error("Review memory candidate exceeds its byte budget");
  const candidate = JSON.parse(body);
  const record = parseMemoryRecord(JSON.stringify(candidate.record));
  if (
    candidate.version !== 1 ||
    typeof candidate.repository !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(candidate.repository) ||
    !Number.isSafeInteger(candidate.runId) ||
    candidate.runId < 1 ||
    !record
  )
    throw new Error("Invalid review memory candidate");
  return {
    version: 1,
    repository: candidate.repository,
    runId: candidate.runId,
    record,
  };
}

/** Write one candidate per run to a private staging directory, never to source files. */
export async function stageReviewMemory(
  directory: string,
  source: { repository: string; runId: number; pr: number; head: string },
  learning: { paths: string[]; note: string },
): Promise<void> {
  if (!validMemoryPaths(learning.paths))
    throw new Error("Invalid review memory paths");
  const candidate = parseReviewCandidate(
    JSON.stringify({
      version: 1,
      repository: source.repository,
      runId: source.runId,
      record: {
        version: 1,
        sourcePr: source.pr,
        head: source.head,
        paths: [...new Set(learning.paths)].sort(),
        note: cleanMemoryNote(learning.note),
      },
    }),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Review memory staging directory must not be a symlink");
  await writeFile(
    join(directory, "candidate.json"),
    JSON.stringify(candidate),
    { mode: 0o600, flag: "wx" },
  );
}
