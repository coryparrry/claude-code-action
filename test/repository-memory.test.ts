import { describe, expect, test } from "bun:test";
import {
  boundRepositoryMemory,
  parseMemoryRecord,
  validMemoryPaths,
} from "../src/github/data/repository-memory";
import {
  loadRepositoryMemory,
  readMemorySnapshot,
  reconcilePullMemory,
  storeRepositoryMemory,
} from "../src/github/data/repository-memory-store";
import {
  memoryFixture,
  memoryOptions,
  memoryRecord,
} from "./fixtures/repository-memory";

const current = { pr: 2, changedPaths: ["src/access.ts"], baseRef: "main" };
const state = {
  merged: false,
  baseRef: "main",
  updatedAt: "2026-11-01T12:00:00Z",
};

describe("automatic branch-backed repository memory", () => {
  test("provisions automatically and publishes PR 1 knowledge to PR 2 only after exact-head merge", async () => {
    const fixture = memoryFixture();
    expect(
      (await loadRepositoryMemory(fixture.client, memoryOptions, current))
        .records,
    ).toHaveLength(0);
    await storeRepositoryMemory(
      fixture.client,
      memoryOptions,
      memoryRecord,
      state,
    );
    expect(fixture.branch()).toBeDefined();
    expect(
      (await loadRepositoryMemory(fixture.client, memoryOptions, current))
        .records,
    ).toHaveLength(0);
    fixture.pulls.get(1).merged_at = "2026-11-01";
    fixture.pulls.get(1).state = "closed";
    await reconcilePullMemory(fixture.client, memoryOptions, 1);
    expect(
      (await loadRepositoryMemory(fixture.client, memoryOptions, current))
        .records,
    ).toEqual([memoryRecord]);
    expect(
      (
        await loadRepositoryMemory(fixture.client, memoryOptions, {
          ...current,
          changedPaths: ["docs/a.md"],
        })
      ).records,
    ).toHaveLength(0);
    expect(
      (
        await loadRepositoryMemory(fixture.client, memoryOptions, {
          ...current,
          baseRef: "release",
        })
      ).records,
    ).toHaveLength(0);
    expect(
      (
        await loadRepositoryMemory(fixture.client, memoryOptions, {
          ...current,
          pr: 1,
        })
      ).records,
    ).toHaveLength(0);
  });

  test("concurrent cold starts and updates use non-forced refs and preserve both records", async () => {
    const fixture = memoryFixture();
    fixture.beforeRef(async () => {
      await storeRepositoryMemory(
        fixture.client,
        memoryOptions,
        {
          ...memoryRecord,
          sourcePr: 2,
          head: "b".repeat(40),
          note: "Concurrent knowledge",
        },
        state,
      );
    });
    await storeRepositoryMemory(
      fixture.client,
      memoryOptions,
      memoryRecord,
      state,
    );
    expect(
      (await readMemorySnapshot(fixture.client, memoryOptions)).index.entries,
    ).toHaveLength(2);
    fixture.beforeRef(async () => {
      await storeRepositoryMemory(
        fixture.client,
        memoryOptions,
        { ...memoryRecord, sourcePr: 3, note: "Another concurrent knowledge" },
        state,
      );
    });
    await storeRepositoryMemory(fixture.client, memoryOptions, memoryRecord, {
      ...state,
      merged: true,
    });
    const index = (await readMemorySnapshot(fixture.client, memoryOptions))
      .index;
    expect(index.entries).toHaveLength(3);
    expect(
      index.entries.find(
        (entry) =>
          entry.sourcePr === memoryRecord.sourcePr &&
          entry.head === memoryRecord.head,
      )?.merged,
    ).toBe(true);
    expect(
      fixture.calls
        .filter((call) => call.name === "updateRef")
        .every((call) => call.input.force === false),
    ).toBe(true);
  });

  test("movable PR states preserve pending knowledge; exact merge retires only superseded heads", async () => {
    const fixture = memoryFixture();
    await storeRepositoryMemory(
      fixture.client,
      memoryOptions,
      memoryRecord,
      state,
    );
    fixture.pulls.get(1).head.sha = "c".repeat(40);
    await reconcilePullMemory(fixture.client, memoryOptions, 1);
    expect(
      (await readMemorySnapshot(fixture.client, memoryOptions)).index.entries,
    ).toHaveLength(1);
    const newer = {
      ...memoryRecord,
      head: "c".repeat(40),
      note: "Newer revision learning",
    };
    await storeRepositoryMemory(fixture.client, memoryOptions, newer, state);
    fixture.pulls.get(1).state = "closed";
    await reconcilePullMemory(fixture.client, memoryOptions, 1);
    expect(
      (await readMemorySnapshot(fixture.client, memoryOptions)).index.entries,
    ).toHaveLength(2);
    expect(
      (await loadRepositoryMemory(fixture.client, memoryOptions, current))
        .records,
    ).toHaveLength(0);
    fixture.pulls.get(1).merged_at = "2026-11-01";
    await reconcilePullMemory(fixture.client, memoryOptions, 1);
    const published = (await readMemorySnapshot(fixture.client, memoryOptions))
      .index.entries;
    expect(published).toHaveLength(1);
    expect(published[0]?.head).toBe(newer.head);
    expect(published[0]?.merged).toBe(true);
  });

  test("an index containing 500 published records still retains a new pending candidate", async () => {
    const fixture = memoryFixture();
    const entries = Array.from({ length: 500 }, (_, index) => {
      const record = { ...memoryRecord, sourcePr: index + 10 };
      return {
        ...record,
        merged: true,
        baseRef: "main",
        updatedAt: "2026-01-01T00:00:00Z",
      };
    });
    const tree = await fixture.api.git.createTree({
      tree: [
        {
          path: "index.json",
          content: JSON.stringify({
            version: 1,
            repository: "owner/repo",
            entries,
          }),
        },
      ],
    });
    const commit = await fixture.api.git.createCommit({
      tree: tree.data.sha,
      parents: [],
    });
    await fixture.api.git.createRef({ sha: commit.data.sha });
    await storeRepositoryMemory(
      fixture.client,
      memoryOptions,
      memoryRecord,
      state,
    );
    const snapshot = await readMemorySnapshot(fixture.client, memoryOptions);
    expect(snapshot.index.entries).toHaveLength(500);
    expect(
      snapshot.index.entries.some(
        (entry) =>
          entry.sourcePr === memoryRecord.sourcePr &&
          entry.head === memoryRecord.head,
      ),
    ).toBe(true);
  });

  test("path lookup covers later file pages and reports a bounded inventory gap", async () => {
    const fixture = memoryFixture();
    await storeRepositoryMemory(fixture.client, memoryOptions, memoryRecord, {
      ...state,
      merged: true,
    });
    fixture.api.pulls.listFiles = async ({ page }: any) => ({
      data:
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              filename: `docs/${index}.md`,
            }))
          : [{ filename: "src/access.ts" }],
    });
    expect(
      (
        await loadRepositoryMemory(fixture.client, memoryOptions, {
          ...current,
          changedPaths: [],
          pathsComplete: false,
        })
      ).records,
    ).toHaveLength(1);
    fixture.api.pulls.listFiles = async () => ({
      data: Array.from({ length: 100 }, (_, index) => ({
        filename: `src/${index}.ts`,
      })),
    });
    expect(
      (
        await loadRepositoryMemory(fixture.client, memoryOptions, {
          ...current,
          pathsComplete: false,
        })
      ).status,
    ).toContain("coverage may be incomplete");
  });

  test("rejects malformed notes, redacts encoded secrets and bounds retrieved context", () => {
    expect(
      parseMemoryRecord(
        JSON.stringify({
          ...memoryRecord,
          note: "sk&#45;proj-" + "x".repeat(40),
        }),
      )?.note,
    ).not.toContain("sk-proj-");
    expect(
      parseMemoryRecord(JSON.stringify({ ...memoryRecord, sourcePr: -1 })),
    ).toBeUndefined();
    for (const path of ["../src", "/src", ".git/", "src/*", "src/\ncommand"])
      expect(validMemoryPaths([path])).toBe(false);
    expect(
      Buffer.byteLength(
        JSON.stringify(
          boundRepositoryMemory(
            Array.from({ length: 10 }, (_, index) => ({
              ...memoryRecord,
              sourcePr: index + 1,
              note: "界".repeat(200),
            })),
          ),
        ),
      ),
    ).toBeLessThanOrEqual(2000);
  });
});

test("the retrieval budget counts the encoded prompt bytes, including escaped delimiters", () => {
  const expansion = { ...memoryRecord, note: "<".repeat(500) };
  const selected = boundRepositoryMemory([expansion, memoryRecord]);
  expect(selected).toEqual([memoryRecord]);
  expect(
    Buffer.byteLength(JSON.stringify(selected).replaceAll("<", "\\u003c")),
  ).toBeLessThanOrEqual(2000);
});
