import { createHash } from "node:crypto";
import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { RepositoryMemoryRecord } from "./repository-memory";

const issuer = "https://token.actions.githubusercontent.com";
const githubKeys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
type CandidateData = {
  version: 1;
  repository: string;
  runId: number;
  record: RepositoryMemoryRecord;
  proof?: string;
};
type SourceRun = {
  id: number;
  run_attempt?: number;
  created_at: string;
  run_started_at?: string;
  updated_at: string;
};

/** Bind the signed audience to the exact proposal without exposing its contents in claims. */
export function reviewProofAudience(candidate: CandidateData): string {
  const { version, repository, runId, record } = candidate;
  return `codex-review-memory:v1:${createHash("sha256").update(JSON.stringify({ version, repository, runId, record })).digest("hex")}`;
}

/** Bound issuance to the source run; signature verification authenticates these same temporal claims. */
function historicalProofTime(proof: string, run: SourceRun): Date {
  const { iat, exp } = decodeJwt(proof);
  if (
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp) ||
    exp <= iat
  )
    throw new Error("Invalid review proof timestamps");
  const started = Date.parse(run.run_started_at ?? run.created_at);
  const completed = Date.parse(run.updated_at);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    iat < Math.floor(started / 1000) ||
    iat > Math.ceil(completed / 1000)
  )
    throw new Error("Review proof was not issued during the source run");
  return new Date(iat * 1000);
}

/** Verify historical job provenance at signed issuance, independent of subsequent upload or publisher delay. */
export async function verifyReviewProof(
  candidate: CandidateData,
  run: SourceRun,
  repositoryId: number,
  getKey: JWTVerifyGetKey = githubKeys,
): Promise<string> {
  if (!candidate.proof) throw new Error("Missing signed review provenance");
  const { payload } = await jwtVerify(candidate.proof, getKey, {
    issuer,
    audience: reviewProofAudience(candidate),
    algorithms: ["RS256"],
    currentDate: historicalProofTime(candidate.proof, run),
  });
  if (
    payload.repository_id !== String(repositoryId) ||
    payload.run_id !== String(run.id) ||
    payload.run_attempt !== String(run.run_attempt ?? 1) ||
    payload.event_name !== "pull_request" ||
    payload.ref !== `refs/pull/${candidate.record.sourcePr}/merge` ||
    typeof payload.workflow_sha !== "string" ||
    !/^[a-f0-9]{40,64}$/i.test(payload.workflow_sha)
  )
    throw new Error(
      "Signed review provenance does not match the repository, run or PR",
    );
  return payload.workflow_sha;
}
