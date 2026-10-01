import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  agentSessionDirectory,
  loadAgentSession,
  saveAgentSession,
} from "../src/agent-sessions";

test("saved histories resume by id or latest only inside their workspace", async () => {
  const storage = await mkdtemp(`${tmpdir()}/agent-session-test-`);
  try {
    const directory = agentSessionDirectory(storage, "/workspace");
    expect(
      await loadAgentSession(directory, "/workspace", undefined, true),
    ).toBeUndefined();
    const session = {
      version: 1 as const,
      sessionId: "test-session",
      workspace: "/workspace",
      history: [{ role: "user" as const, content: "Continue the task" }],
    };
    await saveAgentSession(directory, session);
    expect(
      await loadAgentSession(directory, "/workspace", "test-session"),
    ).toEqual(session);
    expect(
      await loadAgentSession(directory, "/workspace", undefined, true),
    ).toEqual(session);
    await expect(
      loadAgentSession(directory, "/another", "test-session"),
    ).rejects.toThrow("workspace");
    await expect(
      loadAgentSession(directory, "/workspace", "../secret"),
    ).rejects.toThrow("identifier");
    expect(agentSessionDirectory(storage, "/another")).not.toBe(directory);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});
