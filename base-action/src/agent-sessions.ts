import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentInputItem } from "@openai/agents";

export type SavedAgentSession = {
  version: 1;
  sessionId: string;
  workspace: string;
  history: AgentInputItem[];
};

function sessionPath(directory: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw new Error("Invalid agent session identifier");
  return join(directory, `${id}.json`);
}
export function agentSessionDirectory(
  storage: string,
  workspace: string,
): string {
  return join(
    storage,
    createHash("sha256").update(workspace).digest("hex").slice(0, 24),
  );
}
export async function loadAgentSession(
  directory: string,
  workspace: string,
  id?: string,
  latest = false,
): Promise<SavedAgentSession | undefined> {
  if (latest && !id) {
    try {
      id = (await readFile(join(directory, "latest"), "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  if (!id) return undefined;
  const parsed: unknown = JSON.parse(
    await readFile(sessionPath(directory, id), "utf8"),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid saved agent session");
  const value = parsed as SavedAgentSession;
  if (
    value.version !== 1 ||
    value.sessionId !== id ||
    value.workspace !== workspace ||
    !Array.isArray(value.history)
  )
    throw new Error("Agent session does not match this workspace");
  return value;
}
export async function saveAgentSession(
  directory: string,
  session: SavedAgentSession,
): Promise<string> {
  const destination = sessionPath(directory, session.sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(session), { mode: 0o600 });
  await rename(temporary, destination);
  await writeFile(join(directory, "latest"), session.sessionId, {
    mode: 0o600,
  });
  return destination;
}
