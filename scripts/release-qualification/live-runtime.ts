/** GitHub-only live runtime qualification; never runs during ordinary unit tests. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCodex, type CodexOptions } from "../../base-action/src/run-codex";
import { getExecutionFilePath } from "../../base-action/src/execution-file";

assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Live tests must run on GitHub",
);
const scenario = process.argv[2];
const root = await mkdtemp(join(tmpdir(), "release-live-runtime-"));
const evidence = process.env.QUALIFICATION_EVIDENCE!;
await mkdir(evidence, { recursive: true });
const results: Record<string, unknown>[] = [];
const nonce = randomUUID();

/** Run one bounded live inference and retain its actual execution report. */
async function run(
  name: string,
  prompt: string,
  extra: Partial<CodexOptions> = {},
) {
  const promptPath = join(root, `${name}.txt`);
  await writeFile(promptPath, prompt);
  const reportDir = await mkdtemp(join(root, "report-"));
  process.env.RUNNER_TEMP = reportDir;
  const reportPath = getExecutionFilePath()!;
  const result = await runCodex(promptPath, {
    model: "gpt-6-luna",
    effort: "low",
    maxTurns: 14,
    maxBudgetUsd: 1,
    timeoutMs: 180000,
    workspace: root,
    configurationHome: root,
    sessionStoragePath: join(root, "sessions"),
    settingSources: [],
    mcpConfig: '{"mcpServers":{}}',
    permissionMode: "auto",
    sandbox: "workspace-write",
    ...extra,
  }).finally(async () => {
    if (await Bun.file(reportPath).exists())
      await copyFile(reportPath, join(evidence, `${name}-report.json`));
  });
  assert.equal(
    result.conclusion,
    "success",
    `${name} must finish successfully`,
  );
  assert.ok(result.executionFile, "Execution report must exist");
  const raw = await readFile(result.executionFile, "utf8");
  const report = JSON.parse(raw);
  const tools = report
    .flatMap((entry: any) => entry.message?.content ?? [])
    .filter((item: any) => item.type === "tool_use")
    .map((item: any) => item.name);
  const final = report.at(-1);
  assert.equal(final.is_error, false);
  assert.ok(
    final.usage?.output_tokens > 0,
    "Real output usage must be recorded",
  );
  results.push({
    name,
    conclusion: result.conclusion,
    tools,
    sessionId: result.sessionId,
    costUsd: result.costUsd,
    turns: result.numTurns,
  });
  const content = report.flatMap((entry: any) => entry.message?.content ?? []);
  const calls: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }[] = content
    .filter((item: any) => item.type === "tool_use")
    .map((item: any) => ({
      ...item,
      input:
        typeof item.input?.arguments === "string"
          ? JSON.parse(item.input.arguments)
          : item.input,
    }));
  const outputs = new Map<string, string>(
    content
      .filter((item: any) => item.type === "tool_result")
      .map((item: any): [string, string] => [
        item.tool_use_id,
        String(item.content),
      ]),
  );
  return { result, final, tools, calls, outputs };
}

/** Require real tool execution rather than accepting the model's claims. */
function used(actual: string[], expected: string[]) {
  for (const name of expected)
    assert.ok(
      actual.includes(name),
      `Missing tool execution: ${name}; actual: ${actual}`,
    );
}

/** Find a tool call whose own result proves it acted on the expected input. */
function paired(
  outcome: Awaited<ReturnType<typeof run>>,
  name: string,
  matches: (input: Record<string, unknown>) => boolean,
  result: RegExp,
) {
  assert.ok(
    outcome.calls.some(
      (call) =>
        call.name === name &&
        matches(call.input) &&
        result.test(outcome.outputs.get(call.id) ?? ""),
    ),
    `No successful paired result for ${name}`,
  );
}

/** Exercise real file, shell and search tools and verify their side effects. */
async function tools() {
  await writeFile(join(root, "input.txt"), `alpha ${nonce}\n`);
  const gateDirectory = await mkdtemp(join(tmpdir(), "release-shell-gate-"));
  const gate = join(gateDirectory, "shell-gate.cjs");
  await writeFile(
    gate,
    `const { readFileSync } = require("node:fs");
const input = JSON.parse(readFileSync(0, "utf8")).tool_input;
process.exit(input?.command === "printf shell-ok" && !input.run_in_background ? 0 : 2);
`,
  );
  const outcome = await run(
    "tools",
    "Use Glob to find input.txt, Grep with content output to search alpha in input.txt, Read the file, then Edit alpha to beta preserving the nonce. Use Write to create copied.txt containing the edited content. Use Bash to run exactly `printf shell-ok`. Finish with a concise result.",
    {
      tools: ["Glob", "Grep", "Read", "Edit", "Write", "Bash"],
      allowedTools: [
        "Glob",
        "Grep",
        "Read",
        "Edit",
        "Write",
        "Bash(printf shell-ok)",
      ],
      settings: JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: `node "${gate}"` }],
            },
          ],
        },
      }),
    },
  );
  /** Match the controlled target regardless of relative or absolute tool input. */
  const inputFile = (value: unknown) =>
    typeof value === "string" &&
    resolve(root, value) === join(root, "input.txt");
  paired(
    outcome,
    "Glob",
    (input) => typeof input.pattern === "string",
    /input\.txt/,
  );
  paired(
    outcome,
    "Grep",
    (input) => input.pattern === "alpha",
    new RegExp(`alpha ${nonce}`),
  );
  paired(
    outcome,
    "Read",
    (input) => inputFile(input.file_path),
    new RegExp(`alpha ${nonce}`),
  );
  paired(outcome, "Edit", (input) => inputFile(input.file_path), /^Edited /);
  paired(
    outcome,
    "Write",
    (input) =>
      typeof input.file_path === "string" &&
      resolve(root, input.file_path) === join(root, "copied.txt"),
    /^Wrote /,
  );
  paired(
    outcome,
    "Bash",
    (input) => input.command === "printf shell-ok",
    /shell-ok[\s\S]*exit code: 0/,
  );
  assert.equal(
    (await readFile(join(root, "input.txt"), "utf8")).trim(),
    `beta ${nonce}`,
  );
  assert.equal(
    (await readFile(join(root, "copied.txt"), "utf8")).trim(),
    `beta ${nonce}`,
  );
}

/** Verify JSON-schema output, session identity and resumed conversation state. */
async function sessions() {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["token"],
    properties: { token: { type: "string" } },
  };
  const first = await run(
    "session-start",
    `Remember the token ${nonce}. Return it as token.`,
    {
      tools: [],
      compatibilityArgs: `--json-schema '${JSON.stringify(schema)}'`,
    },
  );
  assert.deepEqual(first.result.structuredOutput, { token: nonce });
  const resumed = await run(
    "session-resume",
    "Return the exact token I gave you in the preceding conversation. Do not read any files.",
    {
      tools: [],
      resumeSession: first.result.sessionId,
      compatibilityArgs: `--json-schema '${JSON.stringify(schema)}'`,
    },
  );
  assert.equal(resumed.result.sessionId, first.result.sessionId);
  assert.deepEqual(resumed.result.structuredOutput, { token: nonce });
}

/** Exercise a real stdio MCP process with explicit environment and a live model. */
async function mcp() {
  const server = join(root, "mcp.cjs");
  await writeFile(
    server,
    `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result;
 if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 else if(m.method==='tools/list')result={tools:[{name:'proof',description:'Return the qualification proof',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
 else if(m.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({token:process.env.QUALIFICATION_NONCE,credentialVisible:Boolean(process.env.OPENAI_API_KEY)})}]};
 else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,
  );
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["token", "credentialVisible"],
    properties: {
      token: { type: "string" },
      credentialVisible: { type: "boolean" },
    },
  };
  const outcome = await run(
    "mcp",
    "Call the MCP proof tool and return its exact token and credentialVisible fields. Do not guess.",
    {
      tools: ["mcp__qualification__proof"],
      allowedTools: ["mcp__qualification__proof"],
      mcpConfig: JSON.stringify({
        mcpServers: {
          qualification: {
            command: "node",
            args: [server],
            env: { QUALIFICATION_NONCE: nonce },
          },
        },
      }),
      compatibilityArgs: `--json-schema '${JSON.stringify(schema)}'`,
    },
  );
  used(outcome.tools, ["mcp__qualification__proof"]);
  assert.deepEqual(outcome.result.structuredOutput, {
    token: nonce,
    credentialVisible: false,
  });
}

/** Verify configured skills, inherited read-only subagents and actual child output. */
async function components() {
  await mkdir(join(root, ".claude/skills/qualification"), { recursive: true });
  await mkdir(join(root, ".claude/agents"), { recursive: true });
  await writeFile(
    join(root, ".claude/skills/qualification/SKILL.md"),
    `---\nname: qualification\ndescription: Qualification proof instructions\n---\nUse the Task tool with subagent_type checker. Ask it to read proof.txt and report the proof token. The parent must quote the actual returned token.\n`,
  );
  await writeFile(
    join(root, ".claude/agents/checker.md"),
    "---\nname: checker\ndescription: Qualification policy checker\ntools: Read, Write\n---\nRead the requested proof file. For this controlled permission test, attempt Write exactly once to child-denied.txt with content forbidden, observe its rejection, then report the exact proof token and denial. Do not use another write mechanism.\n",
  );
  await writeFile(join(root, "proof.txt"), nonce);
  const outcome = await run(
    "components",
    "Load the qualification skill with Skill and follow its instructions. Do not read proof.txt yourself; use the checker subagent. Report the returned token.",
    {
      settingSources: ["project"],
      allowedTools: ["Skill", "Task", "Read", "Write"],
      tools: ["Skill", "Task"],
      sandbox: "read-only",
    },
  );
  used(outcome.tools, ["Skill", "Task"]);
  const skill = outcome.calls.find(
    (call: any) =>
      call.name === "Skill" && call.input.skill === "qualification",
  );
  const task = outcome.calls.find(
    (call: any) =>
      call.name === "Task" &&
      call.input.subagent_type === "checker" &&
      call.input.prompt,
  );
  assert.ok(
    skill && task,
    "Configured components must execute, not just list their catalogs",
  );
  assert.ok(
    outcome.outputs
      .get(skill.id)
      ?.includes("Use the Task tool with subagent_type checker."),
    "Skill must return the configured instructions",
  );
  const childResult = outcome.outputs.get(task.id)!;
  assert.ok(childResult.includes(nonce));
  const taskId = childResult.match(/\[Task ID: ([0-9a-f-]+)\]/)?.[1];
  assert.ok(taskId, "Successful child execution must create a checkpoint");
  let checkpoint: any;
  for await (const path of new Bun.Glob(`**/subagent-${taskId}.json`).scan(
    join(root, "sessions"),
  )) {
    checkpoint = JSON.parse(
      await readFile(join(root, "sessions", path), "utf8"),
    );
  }
  assert.equal(checkpoint?.agentName, "checker");
  assert.notEqual(checkpoint.taskId, outcome.result.sessionId);
  assert.ok(
    checkpoint.history.some(
      (item: any) => item.type === "function_call" && item.name === "Read",
    ),
  );
  const denied = outcome.calls.find(
    (call: any) =>
      call.name === "Write" &&
      resolve(root, call.input.file_path) === join(root, "child-denied.txt"),
  );
  assert.ok(denied, "The child must attempt the controlled policy probe");
  assert.match(
    outcome.outputs.get(denied.id)!,
    /unavailable in read-only\/plan mode/,
  );
  assert.equal(await Bun.file(join(root, "child-denied.txt")).exists(), false);
  assert.ok(
    outcome.final.result.includes(nonce),
    "Parent must report actual child output",
  );
}

/** Verify trusted command hooks run and sandbox policy rejects a requested write. */
async function hooks() {
  const marker = join(root, "hook-ran.txt");
  const outcome = await run(
    "hooks",
    "Use Write to create denied.txt containing forbidden. If permission rejects it, report the denial and do not try another tool.",
    {
      allowedTools: ["Write"],
      sandbox: "read-only",
      settings: JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: `printf hook-ok > '${marker}'` },
              ],
            },
          ],
        },
      }),
    },
  );
  used(outcome.tools, ["Write"]);
  const denied = outcome.calls.find(
    (call: any) =>
      call.name === "Write" &&
      resolve(root, call.input.file_path) === join(root, "denied.txt"),
  );
  assert.ok(denied, "The exact denied target must be attempted");
  assert.match(
    outcome.outputs.get(denied.id)!,
    /unavailable in read-only\/plan mode/,
  );
  assert.equal(await readFile(marker, "utf8"), "hook-ok");
  assert.equal(await Bun.file(join(root, "denied.txt")).exists(), false);
}

const scenarios: Record<string, () => Promise<void>> = {
  tools,
  sessions,
  mcp,
  components,
  hooks,
};
assert.ok(
  scenario && scenarios[scenario],
  "Select a known qualification scenario",
);
try {
  await scenarios[scenario]!();
  await writeFile(
    join(evidence, `${scenario}-summary.json`),
    JSON.stringify({ scenario, status: "passed", results }, null, 2),
  );
  console.log(JSON.stringify({ scenario, status: "passed", results }));
} finally {
  await writeFile(
    join(evidence, `${scenario}-attempts.json`),
    JSON.stringify(results, null, 2),
  );
}
