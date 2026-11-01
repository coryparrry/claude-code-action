import { expect, test } from "bun:test";
import {
  publishFixtureRun as publishReviewRun,
  memoryFixture,
  memoryHead,
  memoryOptions,
  memoryRecord,
} from "./fixtures/repository-memory";
import {
  loadRepositoryMemory,
  readMemorySnapshot,
  storeRepositoryMemory,
  reconcilePullMemory,
} from "../src/github/data/repository-memory-store";
import {
  recoverRepositoryLearning,
  renderRepositoryLearning,
} from "../src/github/data/review-memory-candidate";

const pending = {
  merged: false,
  baseRef: "main",
  updatedAt: "2026-11-01T12:00:00Z",
};
const current = { pr: 2, changedPaths: ["src/access.ts"], baseRef: "main" };
/** Emit the artifact produced by this run, optionally targeting a sibling PR. */
function candidate(pr = 1) {
  return JSON.stringify({
    version: 1,
    repository: "owner/repo",
    runId: 42,
    record: { ...memoryRecord, sourcePr: pr },
  });
}

test.each([memoryHead])(
  "PR-authored producer code cannot forge learning: %s",
  async (ref) => {
    const fixture = memoryFixture();
    fixture.workflows.set(ref, "modified-producer");
    await expect(
      publishReviewRun(
        fixture.client,
        memoryOptions,
        42,
        ["trusted-user"],
        async () => candidate(),
      ),
    ).rejects.toThrow("trusted default");
    expect(fixture.branch()).toBeUndefined();
  },
);

test("signed PR identity remains authoritative when REST associations are incomplete", async () => {
  const fixture = memoryFixture();
  fixture.runs.get(42).pull_requests = [{ number: 2 }];
  await publishReviewRun(
    fixture.client,
    memoryOptions,
    42,
    ["trusted-user"],
    async () => candidate(),
  );
  expect(
    (await readMemorySnapshot(fixture.client, memoryOptions)).index.entries[0]
      ?.sourcePr,
  ).toBe(1);
});

test("closed PRs with omitted API associations still require the authenticated producer", async () => {
  const fixture = memoryFixture();
  fixture.runs.get(42).pull_requests = [];
  fixture.pulls.get(1).merged_at = "2026-11-01";
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
  fixture.workflows.set(memoryHead, "forged");
  await expect(
    publishReviewRun(
      fixture.client,
      memoryOptions,
      42,
      ["trusted-user"],
      async () => candidate(),
    ),
  ).rejects.toThrow("trusted default");
});

test("a merged sibling with the same head cannot claim another PR's learning", async () => {
  const fixture = memoryFixture();
  Object.assign(fixture.pulls.get(2), {
    head: fixture.pulls.get(1).head,
    merged_at: "2026-11-01",
    base: { ref: "release" },
  });
  await expect(
    publishReviewRun(
      fixture.client,
      memoryOptions,
      42,
      ["trusted-user"],
      async () => candidate(2),
    ),
  ).rejects.toThrow("Signed review provenance");
  expect(fixture.branch()).toBeUndefined();
});

test("a close-before-maintenance proposal survives reopen and exact-head merge", async () => {
  const fixture = memoryFixture();
  fixture.pulls.get(1).state = "closed";
  await publishReviewRun(
    fixture.client,
    memoryOptions,
    42,
    ["trusted-user"],
    async () => candidate(),
  );
  expect(
    (await loadRepositoryMemory(fixture.client, memoryOptions, current))
      .records,
  ).toEqual([]);
  Object.assign(fixture.pulls.get(1), {
    state: "closed",
    merged_at: "2026-11-01",
  });
  await reconcilePullMemory(fixture.client, memoryOptions, 1);
  expect(
    (await loadRepositoryMemory(fixture.client, memoryOptions, current))
      .records,
  ).toEqual([memoryRecord]);
});

test("read-only merge confirmation recovers a missed token-triggered close event", async () => {
  const fixture = memoryFixture();
  await storeRepositoryMemory(
    fixture.client,
    memoryOptions,
    memoryRecord,
    pending,
  );
  fixture.pulls.get(1).merged_at = "2026-11-01";
  expect(
    (await loadRepositoryMemory(fixture.client, memoryOptions, current))
      .records,
  ).toEqual([memoryRecord]);
  expect(
    (await readMemorySnapshot(fixture.client, memoryOptions)).index.entries[0]
      ?.merged,
  ).toBe(false);
  fixture.pulls.get(1).head.sha = "b".repeat(40);
  expect(
    (await loadRepositoryMemory(fixture.client, memoryOptions, current))
      .records,
  ).toEqual([]);
});

test("duplicate facts do not crowd distinct relevant knowledge out of retrieval", async () => {
  const fixture = memoryFixture();
  await storeRepositoryMemory(
    fixture.client,
    memoryOptions,
    { ...memoryRecord, sourcePr: 99, note: "Distinct older invariant." },
    { ...pending, merged: true, updatedAt: "2026-01-01T00:00:00Z" },
  );
  for (let pr = 10; pr < 18; pr++)
    await storeRepositoryMemory(
      fixture.client,
      memoryOptions,
      { ...memoryRecord, sourcePr: pr },
      { ...pending, merged: true },
    );
  expect(
    (
      await loadRepositoryMemory(fixture.client, memoryOptions, current)
    ).records.map((r) => r.note),
  ).toEqual([memoryRecord.note, "Distinct older invariant."]);
});

test("rename and transfer preserve memory while a foreign repository ID is rejected", async () => {
  const fixture = memoryFixture();
  await storeRepositoryMemory(fixture.client, memoryOptions, memoryRecord, {
    ...pending,
    merged: true,
  });
  const renamed = { owner: "new-owner", repo: "renamed" };
  expect(
    (await loadRepositoryMemory(fixture.client, renamed, current)).records,
  ).toEqual([memoryRecord]);
  await storeRepositoryMemory(
    fixture.client,
    renamed,
    { ...memoryRecord, sourcePr: 3 },
    pending,
  );
  expect(
    (await readMemorySnapshot(fixture.client, renamed)).index.entries,
  ).toHaveLength(2);
  fixture.repository.id = 456;
  await expect(readMemorySnapshot(fixture.client, renamed)).rejects.toThrow(
    "Invalid repository memory index",
  );
});

test("saved review metadata restores a sanitized candidate only for its exact PR and head", () => {
  const source = { pr: 1, head: memoryHead };
  const learning = {
    paths: memoryRecord.paths,
    note: "Use integer cents. <!-- break -->",
  };
  const body = renderRepositoryLearning(learning, source);
  const restored = recoverRepositoryLearning(body, source);
  expect(restored?.note).toContain("Use integer cents.");
  expect(recoverRepositoryLearning(body, { ...source, pr: 2 })).toBeNull();
  expect(
    recoverRepositoryLearning(body, { ...source, head: "b".repeat(40) }),
  ).toBeNull();
  expect(recoverRepositoryLearning(body + body, source)).toBeNull();
  expect(renderRepositoryLearning(null, source)).toBe("");
});

test("pending merge lookup stays within eight distinct PRs", async () => {
  const fixture = memoryFixture();
  let reads = 0;
  const get = fixture.api.pulls.get;
  fixture.api.pulls.get = async (input: any) => {
    reads++;
    return get(input);
  };
  for (let pr = 10; pr < 19; pr++) {
    fixture.pulls.set(pr, { ...fixture.pulls.get(1), number: pr });
    await storeRepositoryMemory(
      fixture.client,
      memoryOptions,
      { ...memoryRecord, sourcePr: pr },
      pending,
    );
  }
  expect(
    (await loadRepositoryMemory(fixture.client, memoryOptions, current))
      .records,
  ).toEqual([]);
  expect(reads).toBe(8);
});

test("retargeting an unchanged head never transfers learning to another base", async () => {
  const fixture = memoryFixture();
  await publishReviewRun(
    fixture.client,
    memoryOptions,
    42,
    ["trusted-user"],
    async () => candidate(),
  );
  fixture.pulls.get(1).base.ref = "release";
  fixture.pulls.get(1).merged_at = "2026-11-01";
  expect(
    (
      await loadRepositoryMemory(fixture.client, memoryOptions, {
        ...current,
        baseRef: "release",
      })
    ).records,
  ).toEqual([]);
  await reconcilePullMemory(fixture.client, memoryOptions, 1);
  expect(
    (await readMemorySnapshot(fixture.client, memoryOptions)).index.entries,
  ).toEqual([]);
  const source = { pr: 1, head: memoryHead, baseRef: "main" };
  const body = renderRepositoryLearning(
    { paths: ["src/"], note: "Main-only constraint." },
    source,
  );
  expect(
    recoverRepositoryLearning(body, { ...source, baseRef: "release" }),
  ).toBeNull();
});

test("a file rename retrieves prior-path knowledge and accepts prior-path proposals", async () => {
  const fixture = memoryFixture();
  fixture.api.pulls.listFiles = async () => ({
    data: [{ filename: "new/access.ts", previous_filename: "src/access.ts" }],
  });
  await storeRepositoryMemory(fixture.client, memoryOptions, memoryRecord, {
    ...pending,
    merged: true,
  });
  expect(
    (
      await loadRepositoryMemory(fixture.client, memoryOptions, {
        ...current,
        changedPaths: [],
        pathsComplete: false,
      })
    ).records,
  ).toEqual([memoryRecord]);
  await publishReviewRun(
    fixture.client,
    memoryOptions,
    42,
    ["trusted-user"],
    async () => candidate(),
  );
});

test("an already merged retargeted PR cannot publish its old-base proposal", async () => {
  const fixture = memoryFixture();
  fixture.pulls.get(1).base.ref = "release";
  fixture.pulls.get(1).merged_at = "2026-11-01";
  expect(
    await publishReviewRun(
      fixture.client,
      memoryOptions,
      42,
      ["trusted-user"],
      async () => candidate(),
    ),
  ).toContain("retargeted");
  expect(fixture.branch()).toBeUndefined();
});
