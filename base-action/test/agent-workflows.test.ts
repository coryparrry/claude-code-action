import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunContext, type FunctionTool } from "@openai/agents";
import {
  createWorkflowRunner,
  parseWorkflow,
  type WorkflowOptions,
} from "../src/agent-workflows";
import { AgentPermissions } from "../src/agent-permissions";
import { createAgentTools, type BackgroundAgentTask } from "../src/agent-tools";
import {
  createAdditionalAgentTools,
  type AdditionalAgentToolOptions,
} from "../src/agent-additional-tools";
import type { AgentConfiguration } from "../src/agent-configuration";
const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];
async function setup(overrides: Partial<WorkflowOptions> = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agent-workflows-")));
  directories.push(cwd);
  const configuration: AgentConfiguration = {
    settings: {},
    sources: [],
    plugins: [],
    mcpServers: {},
    lspServers: {},
    commandDirectories: [],
    skillDirectories: [],
    agentDirectories: [],
    workflowDirectories: [],
    outputStyleDirectories: [],
    hooks: {},
    projectInstructions: "",
  };
  const options: WorkflowOptions = {
    cwd,
    configuration,
    permissions: new AgentPermissions({ cwd, allowedTools: ["Workflow"] }),
    deadline: Date.now() + 5000,
    runSubagent: async (request) => request.prompt,
    ...overrides,
  };
  const runner = createWorkflowRunner(options);
  closers.push(runner.close);
  return { cwd, configuration, options, runner };
}
const script = (body: string) =>
  `export const meta = {name:'example',description:'Test workflow'};\n${body}`;
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("isolated background workflow interpreter", () => {
  test("validates literal metadata and rejects module imports before launch", () => {
    expect(parseWorkflow(script("return 'done'")).meta.name).toBe("example");
    expect(() =>
      parseWorkflow("export const meta={name:foo(),description:'x'};return 1"),
    ).toThrow("computed");
    expect(() => parseWorkflow(script("return import('node:fs')"))).toThrow(
      "module loading",
    );
    expect(() => parseWorkflow(script("export const value = 2;"))).toThrow(
      "only exports",
    );
  });
  test("runs actual isolated JS orchestration with args, phases, parallel agents and structured results", async () => {
    let active = 0,
      max = 0;
    const { runner } = await setup({
      maxConcurrent: 2,
      runSubagent: async (request) => {
        active++;
        max = Math.max(active, max);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return request.schema
          ? JSON.stringify({ files: ["a", "b", "c"] })
          : request.prompt;
      },
    });
    const launch = await runner.launch({
      script: script(
        "phase('discover');const found=await agent('find',{schema:{type:'object',required:['files'],properties:{files:{type:'array',items:{type:'string'}}}}});log('found');const values=await pipeline(found.files,file=>agent(args.prefix+file));return await parallel(values.map(value=>()=>Promise.resolve(value)));",
      ),
      args: { prefix: "audit:" },
    });
    await launch.done;
    const output = JSON.parse(launch.output());
    expect(output.status).toBe("completed");
    expect(output.result).toEqual(["audit:a", "audit:b", "audit:c"]);
    expect(max).toBe(2);
    expect(output.logs).toEqual(["phase: discover", "log: found"]);
  });
  test("named plugin workflows load and same-session resume reuses completed exact calls", async () => {
    let calls = 0;
    const { cwd, configuration, runner } = await setup({
      runSubagent: async (request) => {
        calls++;
        return request.prompt;
      },
    });
    await mkdir(join(cwd, "workflows"));
    await writeFile(
      join(cwd, "workflows", "run.js"),
      script("return await agent('work')"),
    );
    configuration.workflowDirectories.push({
      directory: join(cwd, "workflows"),
      namespace: "plugin",
      pluginRoot: cwd,
    });
    expect((await runner.list())[0]?.name).toBe("plugin:example");
    const first = await runner.launch({ name: "plugin:example" });
    await first.done;
    const second = await runner.launch({
      name: "plugin:example",
      resumeFromRunId: first.runId,
    });
    await second.done;
    expect(JSON.parse(second.output()).result).toBe("work");
    expect(calls).toBe(1);
  });
  test("persisted workflow resumes across adapters with matching calls and editable scripts", async () => {
    let calls = 0;
    const { cwd, options } = await setup({
      runSubagent: async (request) => {
        calls++;
        return request.prompt;
      },
    });
    const storage = join(cwd, "session");
    const first = createWorkflowRunner({
      ...options,
      sessionStoragePath: storage,
    });
    closers.push(first.close);
    const launch = await first.launch({
      script: script("return await agent('cached')"),
    });
    await launch.done;
    expect(launch.scriptPath).toContain(storage);
    const resumed = createWorkflowRunner({
      ...options,
      sessionStoragePath: storage,
    });
    closers.push(resumed.close);
    const second = await resumed.launch({
      scriptPath: launch.scriptPath,
      resumeFromRunId: launch.runId,
    });
    await second.done;
    expect(JSON.parse(second.output()).result).toBe("cached");
    expect(calls).toBe(1);
  });
  test("resume invalidates completed suffix after the first edited or failed agent call", async () => {
    const calls: string[] = [];
    let fail = true;
    const { runner } = await setup({
      runSubagent: async ({ prompt }) => {
        calls.push(prompt);
        if (prompt === "B" && fail) throw new Error("API unavailable");
        return prompt;
      },
    });
    const source = script(
      "return await pipeline(['A','B','C'], item=>agent(item))",
    );
    const first = await runner.launch({ script: source });
    await first.done;
    expect(JSON.parse(first.output()).result).toEqual(["A", null, "C"]);
    expect(JSON.parse(first.output()).status).toBe("completed");
    fail = false;
    calls.length = 0;
    const second = await runner.launch({
      script: source,
      resumeFromRunId: first.runId,
    });
    await second.done;
    expect(calls).toEqual(["B", "C"]);
    expect(JSON.parse(second.output()).result).toEqual(["A", "B", "C"]);
    calls.length = 0;
    const third = await runner.launch({
      script: script(
        "return await pipeline(['A','changed','C'], item=>agent(item))",
      ),
      resumeFromRunId: second.runId,
    });
    await third.done;
    expect(calls).toEqual(["changed", "C"]);
    expect(JSON.parse(third.output()).result).toEqual(["A", "changed", "C"]);
  });
  test("isolates host credentials, constructors, filesystem, clocks and randomness", async () => {
    const { runner } = await setup();
    for (const body of [
      "return typeof process + ':' + typeof require",
      "return __send.constructor",
      "const error=__send({});return error.constructor.constructor('return process')()",
      "return Date.now()",
      "return Math.random()",
      "return globalThis.constructor.constructor('return process')()",
    ]) {
      const launch = await runner.launch({ script: script(body) });
      await launch.done;
      const output = JSON.parse(launch.output());
      if (body.includes("typeof process"))
        expect(output.result).toBe("undefined:undefined");
      else if (body.includes("__send.constructor"))
        expect(output.result).toBeNull();
      else expect(output.status).toBe("failed");
    }
  });
  test("infinite scripts, oversized pipelines and cancelled runs terminate", async () => {
    const { runner } = await setup({ deadline: Date.now() + 3000 });
    const infinite = await runner.launch({ script: script("while(true){}") });
    await infinite.done;
    expect(JSON.parse(infinite.output()).status).toBe("failed");
    const large = await runner.launch({
      script: script("return await pipeline(Array(4097), x=>x)"),
    });
    await large.done;
    expect(JSON.parse(large.output()).error).toContain("4096");
    const waiting = await runner.launch({
      script: script("return await new Promise(()=>{})"),
    });
    expect(JSON.parse(await waiting.stop()).status).toBe("stopped");
  });
  test("structured results retry invalid JSON and resume unknown ids fail explicitly", async () => {
    let calls = 0;
    const { runner } = await setup({
      runSubagent: async () =>
        ++calls === 1 ? "invalid" : JSON.stringify({ ok: true }),
    });
    const launch = await runner.launch({
      script: script(
        "return await agent('check',{schema:{type:'object',required:['ok'],properties:{ok:{type:'boolean'}}}})",
      ),
    });
    await launch.done;
    expect(JSON.parse(launch.output()).result).toEqual({ ok: true });
    expect(calls).toBe(2);
    calls = 0;
    const contradictory = await runner.launch({
      script: script(
        "return await agent('check',{schema:{type:'object',required:['missing'],additionalProperties:false,properties:{ok:{type:'boolean'}}}})",
      ),
    });
    await contradictory.done;
    expect(JSON.parse(contradictory.output()).error).toContain("contradiction");
    expect(calls).toBe(0);
    await expect(
      runner.launch({
        script: script("return 1"),
        resumeFromRunId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toThrow("resume run");
  });
  test("additional SDK TaskOutput/TaskStop retrieve and cancel background subagents/workflows", async () => {
    const { cwd, configuration } = await setup();
    await mkdir(join(cwd, "agents"));
    await writeFile(join(cwd, "agents", "worker.md"), "Work");
    configuration.agentDirectories.push({ directory: join(cwd, "agents") });
    const options: AdditionalAgentToolOptions = {
      cwd,
      configuration,
      env: {},
      deadline: Date.now() + 5000,
      allowedTools: ["Task", "Workflow"],
      runSubagent: async (request) => {
        if (request.prompt === "slow") return new Promise(() => {});
        return request.prompt;
      },
    };
    const tools = createAdditionalAgentTools(options);
    closers.push(tools.close);
    const invoke = async (name: string, input: Record<string, unknown>) =>
      String(
        await (
          tools.tools.find(
            (candidate) => candidate.name === name,
          ) as FunctionTool
        ).invoke(new RunContext(), JSON.stringify(input)),
      );
    const task = JSON.parse(
      await invoke("Task", {
        subagent_type: "worker",
        prompt: "done",
        run_in_background: true,
      }),
    );
    expect(task.status).toBe("async_launched");
    expect(
      JSON.parse(await invoke("TaskOutput", { task_id: task.task_id })).output,
    ).toBe("done");
    const slow = JSON.parse(
      await invoke("Task", {
        subagent_type: "worker",
        prompt: "slow",
        run_in_background: true,
      }),
    );
    expect(
      JSON.parse(await invoke("TaskStop", { task_id: slow.task_id })).status,
    ).toBe("stopped");
    const workflow = JSON.parse(
      await invoke("Workflow", {
        script: script("return await agent('workflow done')"),
      }),
    );
    expect(workflow.status).toBe("async_launched");
    expect(
      JSON.parse(await invoke("TaskOutput", { task_id: workflow.task_id }))
        .result,
    ).toBe("workflow done");
  });
  test("TaskOutput and deprecated shell_id TaskStop bridge real background shell jobs", async () => {
    const { cwd, configuration } = await setup();
    const backgroundTasks = new Map<string, BackgroundAgentTask>();
    const core = createAgentTools({
      cwd,
      env: { PATH: "/usr/bin:/bin" },
      allowedTools: ["Bash"],
      backgroundTasks,
    });
    const additional = createAdditionalAgentTools({
      cwd,
      configuration,
      env: {},
      backgroundTasks,
    });
    closers.push(additional.close);
    const invoke = async (
      tools: typeof core,
      name: string,
      input: Record<string, unknown>,
    ) =>
      String(
        await (tools.find((tool) => tool.name === name) as FunctionTool).invoke(
          new RunContext(),
          JSON.stringify(input),
        ),
      );
    const shell = JSON.parse(
      await invoke(core, "Bash", {
        command: "printf hello; sleep 30",
        run_in_background: true,
      }),
    );
    expect(
      await invoke(additional.tools, "TaskOutput", {
        task_id: shell.shell_id,
        block: false,
      }),
    ).toContain("running");
    expect(
      await invoke(additional.tools, "TaskStop", { shell_id: shell.shell_id }),
    ).toContain("exit code");
  });
  test("preloaded skills and nested agent hooks reach the parent callback", async () => {
    const { cwd, configuration } = await setup();
    await mkdir(join(cwd, "skills", "review"), { recursive: true });
    await mkdir(join(cwd, "agents"));
    await writeFile(
      join(cwd, "skills", "review", "SKILL.md"),
      "Review carefully",
    );
    await writeFile(
      join(cwd, "agents", "audit.md"),
      "---\nskills: [review]\nhooks:\n  PreToolUse:\n    - matcher: Read\n      hooks:\n        - type: command\n          command: echo ok\n---\nAudit",
    );
    configuration.skillDirectories.push({ directory: join(cwd, "skills") });
    configuration.agentDirectories.push({ directory: join(cwd, "agents") });
    let received: unknown;
    const tools = createAdditionalAgentTools({
      cwd,
      configuration,
      env: {},
      allowedTools: ["Task"],
      runSubagent: async (request) => {
        received = request;
        return "ok";
      },
    });
    closers.push(tools.close);
    const task = tools.tools.find(
      (tool) => tool.name === "Task",
    ) as FunctionTool;
    await task.invoke(
      new RunContext(),
      JSON.stringify({ subagent_type: "audit", prompt: "go" }),
    );
    expect((received as any).instructions).toContain("Review carefully");
    expect((received as any).hooks.PreToolUse).toHaveLength(1);
  });
});
