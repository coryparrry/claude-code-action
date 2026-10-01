import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { splitCompatibilityArgs } from "./codex-compat";

/** Expand only an explicit prompt/request command, never commands embedded in fetched context. */
export async function expandCommand(
  prompt: string,
  workspace = process.cwd(),
): Promise<string> {
  const match =
    /^\s*\/([A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*)(?:\s+([^]*))?$/.exec(prompt);
  if (!match) {
    if (/^\s*\//.test(prompt)) throw new Error("Invalid slash-command name");
    return prompt;
  }
  const command = match[1]!.replace(/:/g, "/");
  const argumentsText = match[2]?.trim() || "";
  for (const directory of [".codex/commands", ".claude/commands"]) {
    const root = resolve(workspace, directory);
    const path = join(root, `${command}.md`);
    let source: string;
    try {
      const canonical = await realpath(path);
      const canonicalRoot = await realpath(root);
      const repository = await realpath(workspace);
      if (relative(repository, canonicalRoot).startsWith(".."))
        throw new Error(
          "Slash-command directory must remain inside the repository",
        );
      const location = relative(canonicalRoot, canonical);
      if (
        location.startsWith("..") ||
        resolve(canonicalRoot, location) !== canonical
      )
        throw new Error(
          "Slash-command file must remain inside the repository commands directory",
        );
      source = await readFile(canonical, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // Claude command metadata is not an instruction for the model.
    source = source.replace(/^---\r?\n[^]*?\r?\n---(?:\r?\n|$)/, "");
    const positional = splitCompatibilityArgs(argumentsText);
    return source.replace(
      /\$ARGUMENTS\b|\$([1-9]\d*)\b/g,
      (token, position: string | undefined) =>
        position
          ? positional[Number(position) - 1] || ""
          : token === "$ARGUMENTS"
            ? argumentsText
            : token,
    );
  }
  throw new Error(
    `Slash-command /${match[1]} was not found in .codex/commands or .claude/commands`,
  );
}
