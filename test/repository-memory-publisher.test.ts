import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishReviewRun,
  readCandidateArchive,
} from "../src/github/operations/publish-review-memory";
import {
  loadRepositoryMemory,
  readMemorySnapshot,
  reconcilePullMemory,
  storeRepositoryMemory,
} from "../src/github/data/repository-memory-store";
import {
  memoryFixture,
  memoryHead,
  memoryOptions,
  memoryRecord,
} from "./fixtures/repository-memory";

/** Build the exact artifact manifest produced by the candidate tool. */
function candidate(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    repository: "owner/repo",
    runId: 42,
    record: memoryRecord,
    ...overrides,
  });
}

test("trusted completion stages pending memory and PR close publishes it without a model call", async () => {
  const fixture = memoryFixture();
  await publishReviewRun(
    fixture.client,
    memoryOptions,
    42,
    ["trusted-user"],
    async () => candidate(),
  );
  expect(
    (await readMemorySnapshot(fixture.client, memoryOptions)).index.entries[0]
      ?.merged,
  ).toBe(false);
  fixture.pulls.get(1).state = "closed";
  fixture.pulls.get(1).merged_at = "2026-11-01";
  await reconcilePullMemory(fixture.client, memoryOptions, 1);
  expect(
    (
      await loadRepositoryMemory(fixture.client, memoryOptions, {
        pr: 2,
        changedPaths: ["src/access.ts"],
        baseRef: "main",
      })
    ).records,
  ).toEqual([memoryRecord]);
});

test("a close event that finishes before the pending commit is repaired by fresh reconciliation", async () => {
  const fixture = memoryFixture();
  fixture.beforeRef(async () => {
    fixture.pulls.get(1).state = "closed";
    fixture.pulls.get(1).merged_at = "2026-11-01";
    await reconcilePullMemory(fixture.client, memoryOptions, 1);
  });
  await publishReviewRun(
    fixture.client,
    memoryOptions,
    42,
    ["trusted-user"],
    async () => candidate(),
  );
  expect(
    (await readMemorySnapshot(fixture.client, memoryOptions)).index.entries[0]
      ?.merged,
  ).toBe(true);
});

test("a stale publisher cannot erase a newer head's pending learning", async () => {
  const fixture = memoryFixture();
  const newer = {
    ...memoryRecord,
    head: "b".repeat(40),
    note: "Newer review knowledge",
  };
  fixture.api.pulls.listFiles = async () => {
    fixture.pulls.get(1).head.sha = newer.head;
    await storeRepositoryMemory(fixture.client, memoryOptions, newer, {
      merged: false,
      baseRef: "main",
      updatedAt: "2026-11-01T13:00:00Z",
    });
    await reconcilePullMemory(fixture.client, memoryOptions, 1);
    return { data: [{ filename: "src/access.ts" }] };
  };
  await publishReviewRun(
    fixture.client,
    memoryOptions,
    42,
    ["trusted-user"],
    async () => candidate(),
  );
  const staged = (await readMemorySnapshot(fixture.client, memoryOptions)).index
    .entries;
  expect(staged.some((entry) => entry.head === newer.head)).toBe(true);
  fixture.pulls.get(1).merged_at = "2026-11-01";
  await reconcilePullMemory(fixture.client, memoryOptions, 1);
  const published = (await readMemorySnapshot(fixture.client, memoryOptions))
    .index.entries;
  expect(published).toHaveLength(1);
  expect(published[0]?.note).toBe(newer.note);
});

test.each([
  { event: "push" },
  { actor: { login: "attacker" } },
  { path: ".github/workflows/other.yml" },
  { conclusion: "failure" },
  { head_repository: { full_name: "attacker/fork" } },
])("non-eligible workflow runs cannot write memory: %j", async (override) => {
  const fixture = memoryFixture();
  Object.assign(fixture.runs.get(42), override);
  expect(
    await publishReviewRun(
      fixture.client,
      memoryOptions,
      42,
      ["trusted-user"],
      async () => candidate(),
    ),
  ).toContain("Skipped");
  expect(fixture.branch()).toBeUndefined();
});

test.each([
  { repository: "other/repo" },
  { runId: 99 },
  { record: { ...memoryRecord, head: "c".repeat(40) } },
  { record: { ...memoryRecord, paths: ["unrelated/"] } },
])("forged candidate provenance or scope is rejected: %j", async (override) => {
  const fixture = memoryFixture();
  await expect(
    publishReviewRun(
      fixture.client,
      memoryOptions,
      42,
      ["trusted-user"],
      async () => candidate(override),
    ),
  ).rejects.toThrow();
  expect(fixture.branch()).toBeUndefined();
});

test("superseded heads and closed-unmerged PRs are discarded, while merge-ref reviews are accepted", async () => {
  const fixture = memoryFixture();
  fixture.pulls.get(1).head.sha = "b".repeat(40);
  expect(
    await publishReviewRun(
      fixture.client,
      memoryOptions,
      42,
      ["trusted-user"],
      async () => candidate(),
    ),
  ).toContain("superseded");
  fixture.pulls.get(1).head.sha = memoryHead;
  fixture.pulls.get(1).state = "closed";
  expect(
    await publishReviewRun(
      fixture.client,
      memoryOptions,
      42,
      ["trusted-user"],
      async () => candidate(),
    ),
  ).toContain("closed unmerged");
  fixture.pulls.get(1).merged_at = "2026-11-01";
  fixture.runs.get(42).head_sha = "d".repeat(40);
  await publishReviewRun(
    fixture.client,
    memoryOptions,
    42,
    ["trusted-user"],
    async () => candidate(),
  );
  expect(
    (await readMemorySnapshot(fixture.client, memoryOptions)).index.entries[0]
      ?.merged,
  ).toBe(true);
});

test("real artifact ZIP decoding is bounded and feeds the trusted publisher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-zip-test-"));
  try {
    await writeFile(join(directory, "candidate.json"), candidate());
    execFileSync("zip", ["-q", "candidate.zip", "candidate.json"], {
      cwd: directory,
    });
    const zip = await readFile(join(directory, "candidate.zip"));
    expect(await readCandidateArchive(zip)).toBe(candidate());
    const fixture = memoryFixture();
    fixture.api.actions.downloadArtifact = async () => ({ data: zip });
    await publishReviewRun(fixture.client, memoryOptions, 42, ["trusted-user"]);
    expect(
      (await readMemorySnapshot(fixture.client, memoryOptions)).index.entries,
    ).toHaveLength(1);
    await expect(readCandidateArchive(new Uint8Array(32769))).rejects.toThrow(
      "size budget",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
