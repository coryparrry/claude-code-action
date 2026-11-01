import { expect, test } from "bun:test";
import {
  memoryRecord,
  signFixtureCandidate,
  verifyFixtureProof,
} from "./fixtures/repository-memory";

const candidate = {
  version: 1 as const,
  repository: "owner/repo",
  runId: 42,
  record: memoryRecord,
};
const run = {
  id: 42,
  run_attempt: 1,
  created_at: "2026-11-01T11:59:00Z",
  updated_at: "2026-11-01T12:00:00Z",
};

test("GitHub-signed job identity binds repository, PR, run, attempt and exact proposal", async () => {
  const signed = JSON.parse(await signFixtureCandidate(candidate));
  expect(await verifyFixtureProof(signed, run, 123)).toBe(memoryRecord.head);
  await expect(
    verifyFixtureProof(
      { ...signed, record: { ...signed.record, note: "forged" } },
      run,
      123,
    ),
  ).rejects.toThrow();
  await expect(
    verifyFixtureProof(signed, { ...run, run_attempt: 2 }, 123),
  ).rejects.toThrow();
  await expect(verifyFixtureProof(signed, run, 456)).rejects.toThrow();
});

test.each([
  { ref: "refs/pull/2/merge" },
  { workflow_sha: "bad" },
  { event_name: "push" },
  { run_id: "99" },
])("invalid signed source identity is rejected: %j", async (claims) => {
  const signed = JSON.parse(await signFixtureCandidate(candidate, claims));
  await expect(verifyFixtureProof(signed, run, 123)).rejects.toThrow();
});

test("signed issuance time permits slow uploads while staying inside the source execution window", async () => {
  const signed = JSON.parse(await signFixtureCandidate(candidate));
  expect(await verifyFixtureProof(signed, run, 123)).toBe(memoryRecord.head);
  expect(
    await verifyFixtureProof(
      signed,
      { ...run, updated_at: "2026-11-01T12:10:00Z" },
      123,
    ),
  ).toBe(memoryRecord.head);
  await expect(
    verifyFixtureProof(
      signed,
      { ...run, created_at: "2026-11-01T12:05:00Z" },
      123,
    ),
  ).rejects.toThrow("source run");
  await expect(
    verifyFixtureProof(
      signed,
      { ...run, updated_at: "2026-11-01T11:58:00Z" },
      123,
    ),
  ).rejects.toThrow("source run");
  await expect(verifyFixtureProof(candidate, run, 123)).rejects.toThrow(
    "Missing signed",
  );
});

test("a modified JWT signature cannot authenticate a candidate", async () => {
  const signed = JSON.parse(await signFixtureCandidate(candidate));
  const parts = signed.proof.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  await expect(
    verifyFixtureProof({ ...signed, proof: parts.join(".") }, run, 123),
  ).rejects.toThrow();
});
