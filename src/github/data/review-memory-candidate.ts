import { reviewProofAudience } from "./review-memory-proof";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanMemoryNote,
  parseMemoryRecord,
  validMemoryPaths,
  type RepositoryMemoryRecord,
  type RepositoryLearning,
} from "./repository-memory";

export type ReviewMemoryCandidate = {
  version: 1;
  repository: string;
  runId: number;
  record: RepositoryMemoryRecord;
  proof?: string;
};

/** Decode a small candidate manifest; provenance remains untrusted until publisher validation. */
export function parseReviewCandidate(body: string): ReviewMemoryCandidate {
  if (Buffer.byteLength(body) > 16384)
    throw new Error("Review memory candidate exceeds its byte budget");
  const candidate = JSON.parse(body);
  const record = parseMemoryRecord(JSON.stringify(candidate.record));
  if (
    (candidate.proof !== undefined &&
      (typeof candidate.proof !== "string" ||
        candidate.proof.length > 12000)) ||
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
    ...(candidate.proof ? { proof: candidate.proof } : {}),
  };
}

/** Write one candidate per run to a private staging directory, never to source files. */
export async function stageReviewMemory(
  directory: string,
  source: { repository: string; runId: number; pr: number; head: string },
  learning: { paths: string[]; note: string },
  getProof?: (audience: string) => Promise<string>,
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
  if (getProof)
    candidate.proof = await getProof(reviewProofAudience(candidate));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Review memory staging directory must not be a symlink");
  const body = JSON.stringify(candidate);
  parseReviewCandidate(body);
  await writeFile(join(directory, "candidate.json"), body, {
    mode: 0o600,
    flag: "wx",
  });
}

/** Persist a sanitized proposal atomically with its native review for zero-model retry recovery. */
export function renderRepositoryLearning(
  learning: RepositoryLearning | null | undefined,
  source: { pr: number; head: string; baseRef?: string },
): string {
  if (!learning) return "";
  const record = parseMemoryRecord(
    JSON.stringify({
      version: 1,
      sourcePr: source.pr,
      head: source.head,
      ...learning,
    }),
  );
  if (!record) return "";
  return `<!-- codex-action:learning:v1:${Buffer.from(JSON.stringify({ ...record, baseRef: source.baseRef })).toString("base64")} -->\n\n`;
}

/** Recover only this exact PR and reviewed revision from trusted native-review metadata. */
export function recoverRepositoryLearning(
  body: string,
  source: { pr: number; head: string; baseRef?: string },
): RepositoryLearning | null {
  const matches = [
    ...body.matchAll(
      /<!-- codex-action:learning:v1:([A-Za-z0-9+/=]{1,12000}) -->/g,
    ),
  ];
  if (matches.length !== 1) return null;
  try {
    const { baseRef, ...value } = JSON.parse(
      Buffer.from(matches[0]![1]!, "base64").toString("utf8"),
    );
    const record = parseMemoryRecord(JSON.stringify(value));
    return record &&
      record.sourcePr === source.pr &&
      record.head === source.head &&
      baseRef === source.baseRef
      ? { paths: record.paths, note: record.note }
      : null;
  } catch {
    return null;
  }
}

/** Omit opaque recovery metadata from model context while preserving native review content. */
export function stripRepositoryLearning(body: string): string {
  return body.replace(
    /<!-- codex-action:learning:v1:[A-Za-z0-9+/=]{1,12000} -->\s*/g,
    "",
  );
}
