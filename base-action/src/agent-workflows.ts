import { substitutePluginConfiguration } from "./agent-configuration";
import { parse } from "@babel/parser";
import Ajv from "ajv";
import {
  agentDefinitions,
  catalog as markdownCatalog,
  stringList,
  substitute,
} from "./agent-markdown";
import { parseHooks } from "./agent-hooks";
import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type {
  AgentConfiguration,
  AgentComponentLocation,
} from "./agent-configuration";
import type { SubagentRequest } from "./agent-additional-tools";
import { AgentPermissions } from "./agent-permissions";

export type WorkflowInput = {
  name?: string | null;
  script?: string | null;
  scriptPath?: string | null;
  args?: unknown;
  resumeFromRunId?: string | null;
};
export type WorkflowDefinition = {
  name: string;
  script: string;
  path?: string;
  pluginRoot?: string;
  meta: Record<string, unknown>;
  body: string;
};
export type WorkflowLaunch = {
  runId: string;
  name: string;
  scriptPath?: string;
  done: Promise<void>;
  output(): string;
  stop(): Promise<string>;
};
export type WorkflowOptions = {
  configuration: AgentConfiguration;
  cwd: string;
  permissions: AgentPermissions;
  signal?: AbortSignal;
  deadline?: number;
  sessionStoragePath?: string;
  runSubagent?: (request: SubagentRequest) => Promise<string>;
  maxConcurrent?: number;
};
type State = {
  script: string;
  args?: unknown;
  cache: Record<string, unknown>;
  logs: string[];
  result?: unknown;
  error?: string;
  status: "running" | "completed" | "failed" | "stopped";
};
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function checkWorkflowSchema(schema: Record<string, unknown>): void {
  let visited = 0;
  const inspect = (value: unknown, depth: number) => {
    if (!object(value)) return;
    if (++visited > 2000 || depth > 30)
      throw new Error("Workflow schema exceeds complexity limit");
    if (
      value.additionalProperties === false &&
      Array.isArray(value.required) &&
      (!object(value.patternProperties) ||
        Object.keys(value.patternProperties).length === 0)
    ) {
      const properties = object(value.properties) ? value.properties : {};
      for (const name of value.required)
        if (typeof name === "string" && !Object.hasOwn(properties, name))
          throw new Error(
            `Workflow schema contradiction: required key '${name}' is excluded by additionalProperties: false`,
          );
    }
    for (const key of [
      "properties",
      "patternProperties",
      "$defs",
      "definitions",
      "dependentSchemas",
    ])
      if (object(value[key]))
        Object.values(value[key]).forEach((entry) => inspect(entry, depth + 1));
    for (const key of [
      "additionalProperties",
      "items",
      "contains",
      "propertyNames",
      "unevaluatedProperties",
      "not",
      "if",
      "then",
      "else",
    ])
      inspect(value[key], depth + 1);
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"])
      if (Array.isArray(value[key]))
        value[key].forEach((entry) => inspect(entry, depth + 1));
  };
  inspect(schema, 0);
}
function literal(value: unknown): unknown {
  if (!object(value)) throw new Error("Workflow metadata must be literal");
  if (
    ["StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(
      String(value.type),
    )
  )
    return value.value;
  if (value.type === "NullLiteral") return null;
  if (
    value.type === "UnaryExpression" &&
    value.operator === "-" &&
    object(value.argument) &&
    value.argument.type === "NumericLiteral"
  )
    return -Number(value.argument.value);
  if (value.type === "ArrayExpression" && Array.isArray(value.elements))
    return value.elements.map(literal);
  if (value.type === "ObjectExpression" && Array.isArray(value.properties)) {
    const result: Record<string, unknown> = {};
    for (const entry of value.properties) {
      if (
        !object(entry) ||
        entry.type !== "ObjectProperty" ||
        entry.computed ||
        !object(entry.key)
      )
        throw new Error("Workflow metadata must be a plain literal object");
      const key =
        entry.key.type === "Identifier" ? entry.key.name : entry.key.value;
      if (
        typeof key !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        Object.hasOwn(result, key)
      )
        throw new Error("Invalid workflow metadata property");
      result[key] = literal(entry.value);
    }
    return result;
  }
  throw new Error("Workflow metadata cannot contain computed values");
}
export function parseWorkflow(script: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  if (Buffer.byteLength(script) > 1024 * 1024)
    throw new Error("Workflow script exceeds 1 MiB");
  const ast = parse(script, {
    sourceType: "module",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });
  const first = ast.program.body[0];
  if (
    !first ||
    first.type !== "ExportNamedDeclaration" ||
    first.declaration?.type !== "VariableDeclaration" ||
    first.declaration.kind !== "const" ||
    first.declaration.declarations.length !== 1
  )
    throw new Error(
      "Workflow must begin with export const meta = { name, description }",
    );
  const declaration = first.declaration.declarations[0]!;
  if (declaration.id.type !== "Identifier" || declaration.id.name !== "meta")
    throw new Error("Workflow must export literal meta first");
  const meta = literal(declaration.init);
  if (
    !object(meta) ||
    typeof meta.name !== "string" ||
    !/^[\w.:-]+$/.test(meta.name) ||
    typeof meta.description !== "string"
  )
    throw new Error("Workflow meta requires name and description");
  function inspect(node: unknown) {
    if (Array.isArray(node)) {
      node.forEach(inspect);
      return;
    }
    if (!object(node)) return;
    if (
      ["ImportDeclaration", "ImportExpression"].includes(String(node.type)) ||
      (node.type === "CallExpression" &&
        object(node.callee) &&
        node.callee.type === "Import")
    )
      throw new Error("Workflow module loading is disabled");
    if (
      node !== (first as unknown) &&
      typeof node.type === "string" &&
      node.type.startsWith("Export")
    )
      throw new Error("Workflow only exports meta");
    for (const [key, value] of Object.entries(node))
      if (!["loc", "comments", "tokens"].includes(key)) inspect(value);
  }
  inspect(ast.program);
  return { meta, body: script.slice(first.end!) };
}
function within(root: string, path: string) {
  const value = relative(root, path);
  return (
    value !== ".." &&
    !value.startsWith("../") &&
    !value.startsWith("..\\") &&
    !isAbsolute(value)
  );
}
async function discover(
  locations: AgentComponentLocation[],
  configuration: AgentConfiguration,
): Promise<WorkflowDefinition[]> {
  const result: WorkflowDefinition[] = [];
  let visited = 0;
  for (const location of locations) {
    const root = await realpath(location.directory),
      files: string[] = [];
    const containment = location.pluginRoot
      ? await realpath(location.pluginRoot)
      : (await stat(root)).isDirectory()
        ? root
        : dirname(root);
    async function walk(path: string, depth: number) {
      if (++visited > 2000 || depth > 8)
        throw new Error("Workflow catalog exceeds structural limits");
      if (!(await stat(path)).isDirectory()) {
        if (path.endsWith(".js")) files.push(path);
        return;
      }
      for (const entry of await readdir(path, { withFileTypes: true }))
        if (
          !entry.isSymbolicLink() &&
          !entry.name.startsWith(".") &&
          (entry.isDirectory() || entry.name.endsWith(".js"))
        )
          await walk(join(path, entry.name), depth + 1);
    }
    await walk(root, 0);
    for (const path of files.sort()) {
      if (!within(containment, await realpath(path)))
        throw new Error("Workflow escapes configured root");
      if ((await stat(path)).size > 1024 * 1024)
        throw new Error("Workflow script exceeds 1 MiB");
      const plugin = configuration.plugins.find(
        (item) => item.root === location.pluginRoot,
      );
      const script = plugin
          ? String(
              substitutePluginConfiguration(
                await readFile(path, "utf8"),
                plugin,
              ),
            )
          : await readFile(path, "utf8"),
        parsed = parseWorkflow(script);
      const name = location.namespace
        ? `${location.namespace}:${parsed.meta.name}`
        : String(parsed.meta.name);
      if (!result.some((entry) => entry.name === name))
        result.push({
          name,
          path,
          pluginRoot: location.pluginRoot,
          script,
          ...parsed,
        });
    }
  }
  return result;
}
// Scripts execute in a disposable worker and a context with no host objects,
// module loading, process, filesystem, shell, timers, credentials, or host promises.
const workerCode = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const vm=require('node:vm');
const send=raw=>{try{if(typeof raw!=='string'||Buffer.byteLength(raw)>1024*1024)return 'Workflow message limit';parentPort.postMessage({type:'rpc',raw});return ''}catch(error){return String(error.message)}};
Object.setPrototypeOf(send,null);Object.freeze(send);
const sandbox=Object.assign(Object.create(null),{__send:send});
const context=vm.createContext(sandbox,{codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'});
const bootstrap = ["let callId=0;const pending=new Map();const dispatch=raw=>{const error=__send(raw);if(error)throw new Error(error)};",
'globalThis.args=JSON.parse('+JSON.stringify(JSON.stringify(workerData.args??null))+');',
'if('+String(workerData.args===undefined)+')globalThis.args=undefined;',
'globalThis.meta=JSON.parse('+JSON.stringify(JSON.stringify(workerData.meta))+');',
"const originalDate=Date;Date=class extends originalDate{constructor(...args){if(!args.length)throw Error('Workflow clock is disabled');super(...args)}static now(){throw Error('Workflow clock is disabled')}};",
"Math.random=()=>{throw Error('Workflow randomness is disabled')};",
"globalThis.agent=(prompt,opts={})=>{if(typeof prompt!=='string')throw Error('agent prompt must be a string');return new Promise((resolve,reject)=>{const id=++callId;pending.set(id,{resolve,reject});dispatch(JSON.stringify({kind:'agent',id,prompt,opts}))})};",
"const list=items=>{if(!Array.isArray(items)||items.length>4096)throw Error('Workflow list exceeds 4096 items');return items};",
"globalThis.parallel=items=>Promise.all(list(items).map(item=>typeof item==='function'?item():item));",
"globalThis.pipeline=(items,fn)=>Promise.all(list(items).map((item,index)=>fn(item,index)));",
"globalThis.phase=title=>{dispatch(JSON.stringify({kind:'phase',message:String(title)}))};",
"globalThis.log=message=>{dispatch(JSON.stringify({kind:'log',message:String(message)}))};",
"globalThis.__complete=value=>dispatch(JSON.stringify({kind:'result',value:value??null}));globalThis.__fail=error=>dispatch(JSON.stringify({kind:'error',message:String(error.message)}));",
"globalThis.__receive=raw=>{const result=JSON.parse(raw),entry=pending.get(result.id);if(!entry)return;pending.delete(result.id);result.error?entry.reject(new Error(result.error)):entry.resolve(result.result)};"].join("\n");
try{
 vm.runInContext(bootstrap,context,{timeout:1000});
 parentPort.on('message',message=>{try{vm.runInContext('__receive('+JSON.stringify(message.raw)+')',context,{timeout:1000})}catch(error){parentPort.postMessage({type:'error',error:String(error.message)})}});
 vm.runInContext('(async()=>{'+workerData.body+'\n})().then(__complete,__fail).catch(__fail)',context,{timeout:1000});
}catch(error){parentPort.postMessage({type:'error',error:String(error.message)})}
`;

export function createWorkflowRunner(options: WorkflowOptions): {
  list(): Promise<WorkflowDefinition[]>;
  nameFor(input: WorkflowInput): Promise<string>;
  launch(input: WorkflowInput): Promise<WorkflowLaunch>;
  close(): Promise<void>;
} {
  const concurrent = options.maxConcurrent ?? 16;
  if (!Number.isSafeInteger(concurrent) || concurrent < 1 || concurrent > 256)
    throw new Error("Workflow concurrency must be between 1 and 256");
  const runs = new Map<string, State>(),
    running = new Map<string, WorkflowLaunch>();
  const ajv = new Ajv({ strict: false, allErrors: true });
  let catalog: Promise<WorkflowDefinition[]> | undefined,
    closed = false;
  const list = () =>
    (catalog ??= discover(
      options.configuration.workflowDirectories ?? [],
      options.configuration,
    ));
  const saves = new Map<string, Promise<void>>();
  async function save(id: string, state: State) {
    if (!options.sessionStoragePath) return;
    const storage = options.sessionStoragePath;
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
      throw new Error("Workflow state exceeds 8 MiB");
    const pending = (saves.get(id) ?? Promise.resolve()).then(async () => {
      await mkdir(storage, { recursive: true });
      await writeFile(join(storage, `${id}.json`), serialized, { mode: 0o600 });
    });
    saves.set(id, pending);
    try {
      await pending;
    } finally {
      if (saves.get(id) === pending) saves.delete(id);
    }
  }
  async function resolveDefinition(
    input: WorkflowInput,
  ): Promise<WorkflowDefinition> {
    let source: WorkflowDefinition;
    if (input.scriptPath) {
      const path = await options.permissions.resolvePath(
        "Read",
        input.scriptPath,
      );
      if ((await stat(path)).size > 1024 * 1024)
        throw new Error("Workflow script exceeds 1 MiB");
      const script = await readFile(path, "utf8");
      source = { script, path, ...parseWorkflow(script), name: "" };
      source.name = String(source.meta.name);
    } else if (input.script) {
      source = {
        script: input.script,
        ...parseWorkflow(input.script),
        name: "",
      };
      source.name = String(source.meta.name);
    } else {
      const found = (await list()).find((entry) => entry.name === input.name);
      if (!found) throw new Error(`Unknown configured workflow: ${input.name}`);
      source = found;
    }
    return source;
  }
  return {
    list,
    nameFor: async (input) => (await resolveDefinition(input)).name,
    launch: async (input) => {
      if (
        closed ||
        options.signal?.aborted ||
        Date.now() >= (options.deadline ?? Infinity)
      )
        throw new Error("Workflow execution cancelled or timed out");
      if (running.size >= 32)
        throw new Error("Workflow background limit reached");
      const source = await resolveDefinition(input);
      options.permissions.assertTool("Workflow", source.name);
      if (!options.runSubagent)
        throw new Error("Workflow subagent runner is unavailable");
      let previous: State | undefined;
      if (input.resumeFromRunId) {
        if (!/^[0-9a-f-]{36}$/i.test(input.resumeFromRunId))
          throw new Error("Invalid workflow run id");
        if (running.has(input.resumeFromRunId))
          throw new Error("Stop a workflow before resuming it");
        previous = runs.get(input.resumeFromRunId);
        if (!previous && options.sessionStoragePath) {
          try {
            const statePath = join(
              options.sessionStoragePath,
              `${input.resumeFromRunId}.json`,
            );
            if ((await stat(statePath)).size > 8 * 1024 * 1024)
              throw new Error("Workflow state exceeds 8 MiB");
            const serialized = await readFile(statePath, "utf8");
            if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
              throw new Error("Workflow state exceeds 8 MiB");
            previous = JSON.parse(serialized) as State;
          } catch {
            throw new Error("Unknown workflow resume run");
          }
        }
        if (
          !previous ||
          !object(previous.cache) ||
          !Array.isArray(previous.logs) ||
          typeof previous.script !== "string"
        )
          throw new Error("Invalid or unknown workflow resume run");
      }
      const runId = randomUUID(),
        state: State = {
          script: source.script,
          args: input.args,
          cache: { ...(previous?.cache ?? {}) },
          logs: [],
          status: "running",
        };
      runs.set(runId, state);
      const scriptPath = options.sessionStoragePath
        ? join(options.sessionStoragePath, `${runId}.js`)
        : source.path;
      if (scriptPath && options.sessionStoragePath) {
        await mkdir(options.sessionStoragePath, { recursive: true });
        await writeFile(scriptPath, source.script, { mode: 0o600 });
      }
      await save(runId, state);
      const controller = new AbortController(),
        worker = new Worker(workerCode, {
          eval: true,
          env: {},
          resourceLimits: {
            maxOldGenerationSizeMb: 128,
            maxYoungGenerationSizeMb: 32,
          },
          workerData: {
            body: source.body,
            meta: source.meta,
            args: input.args,
          },
        });
      let complete!: () => void,
        finished = false,
        replayBroken = !previous,
        calls = 0,
        active = 0;
      const queue: Array<() => void> = [];
      const done = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const abort = () => {
        controller.abort();
        void finish("stopped", "Workflow execution cancelled or timed out");
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        abort,
        Math.max(1, (options.deadline ?? Date.now() + 600_000) - Date.now()),
      );
      const finish = async (status: State["status"], error?: string) => {
        if (finished) return;
        finished = true;
        state.status = status;
        state.error = error;
        controller.abort();
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        queue.splice(0).forEach((resolve) => resolve());
        try {
          await worker.terminate();
          running.delete(runId);
          await save(runId, state);
        } catch (cause) {
          state.status = "failed";
          state.error = String((cause as Error).message);
        } finally {
          complete();
        }
      };
      const launch: WorkflowLaunch = {
        runId,
        name: source.name,
        scriptPath,
        done,
        output: () =>
          JSON.stringify({
            runId,
            workflowName: source.name,
            status: state.status,
            logs: state.logs,
            result: state.result,
            error: state.error,
          }),
        stop: async () => {
          abort();
          await done;
          return launch.output();
        },
      };
      running.set(runId, launch);
      const send = (id: number, result?: unknown, error?: string) => {
        if (!finished)
          worker.postMessage({ raw: JSON.stringify({ id, result, error }) });
      };
      async function call(message: Record<string, unknown>) {
        const id = Number(message.id),
          opts = object(message.opts) ? message.opts : {};
        const prompt = String(message.prompt),
          key = `${id}:${createHash("sha256").update(JSON.stringify({ prompt, opts })).digest("hex")}`;
        if (++calls > 1000) {
          await finish("failed", "Workflow exceeds 1000 agents");
          return;
        }
        if (!replayBroken && Object.hasOwn(state.cache, key)) {
          send(id, state.cache[key]);
          return;
        }
        if (!replayBroken) {
          replayBroken = true;
          for (const cachedKey of Object.keys(state.cache))
            if (Number(cachedKey.split(":", 1)[0]) >= id)
              delete state.cache[cachedKey];
        }
        if (active >= concurrent)
          await new Promise<void>((resolve) => queue.push(resolve));
        if (finished || controller.signal.aborted) return;
        active++;
        try {
          const schema = opts.schema;
          if (schema !== undefined && !object(schema))
            throw new Error("Workflow schema must be an object");
          if (schema) checkWorkflowSchema(schema);
          const validate = schema ? ajv.compile(schema) : undefined;
          const definitionName =
            opts.agent_type ??
            opts.subagent_type ??
            opts.agentType ??
            opts.agent ??
            "general-purpose";
          if (typeof definitionName !== "string")
            throw new Error("Workflow agent type must be a name");
          const definition = (
            await agentDefinitions(options.configuration)
          ).find(
            (agent) =>
              agent.name === definitionName ||
              agent.name ===
                `${source.pluginRoot ? options.configuration.plugins.find((plugin) => plugin.root === source.pluginRoot)?.name : ""}:${definitionName}`,
          );
          if (!definition)
            throw new Error(`Unknown workflow agent type: ${definitionName}`);
          let instructions = substitute(
            definition,
            prompt,
            options.configuration,
          );
          const preloadedSkills = await markdownCatalog(
            options.configuration.skillDirectories,
            "skill",
            undefined,
            options.configuration,
          );
          const loaded = (
            stringList(definition.metadata.skills, "Agent skills") ?? []
          ).map((name) => {
            const skill = preloadedSkills.find(
              (item) =>
                item.name === name ||
                item.name === `${definition.namespace}:${name}`,
            );
            if (!skill)
              throw new Error(`Unknown preloaded agent skill: ${name}`);
            instructions += `\n\nPreloaded skill ${skill.name}:\n${substitute(skill, "", options.configuration)}`;
            return skill;
          });
          const readonly =
            options.permissions.readOnly ||
            ["plan", "readonly", "read-only"].includes(
              String(definition.metadata.permissionMode),
            );
          const maxTurns =
            opts.maxTurns ?? opts.max_turns ?? definition.metadata.maxTurns;
          if (
            maxTurns !== undefined &&
            (!Number.isSafeInteger(maxTurns) ||
              Number(maxTurns) < 1 ||
              Number(maxTurns) > 100)
          )
            throw new Error("Workflow maxTurns must be between 1 and 100");
          let result: unknown;
          let failedAgent = false;
          let errors = "";
          for (let attempt = 0; attempt < (validate ? 5 : 1); attempt++) {
            if (controller.signal.aborted) return;
            const request: SubagentRequest = {
              agent: {
                ...definition,
                instructions,
                metadata: { ...definition.metadata, ...opts },
              },
              name: definition.name,
              instructions,
              preloadedSkills: loaded,
              hooks: parseHooks(definition.metadata.hooks ?? {}, {
                pluginRoot: definition.pluginRoot,
              }),
              mcpServers: options.configuration.strictMcpConfig
                ? undefined
                : definition.metadata.mcpServers,
              prompt: attempt
                ? `${prompt}\nReturn JSON matching the schema. Previous validation errors: ${errors}`
                : prompt,
              model:
                typeof opts.model === "string"
                  ? opts.model
                  : typeof definition.metadata.model === "string"
                    ? definition.metadata.model
                    : undefined,
              maxTurns: maxTurns as number | undefined,
              allowedTools: stringList(
                opts.tools ?? definition.metadata.tools,
                "Workflow tools",
              ),
              disallowedTools: stringList(
                opts.disallowedTools ?? definition.metadata.disallowedTools,
                "Workflow disallowedTools",
              ),
              schema: schema as Record<string, unknown> | undefined,
              label: typeof opts.label === "string" ? opts.label : undefined,
              permissionOptions: {
                ...options.permissions.options,
                ...(readonly
                  ? { permissionMode: "read-only", sandboxMode: "read-only" }
                  : {}),
              },
              signal: controller.signal,
              deadline: options.deadline ?? Date.now() + 600_000,
            };
            let raw: string;
            try {
              raw = await options.runSubagent!(request);
            } catch {
              if (controller.signal.aborted) return;
              failedAgent = true;
              result = null;
              break;
            }
            if (!validate) {
              result = raw;
              break;
            }
            try {
              result = JSON.parse(raw);
              if (validate(result)) break;
              errors = ajv.errorsText(validate.errors);
            } catch (error) {
              errors = String(error);
            }
            if (attempt === 4)
              throw new Error(
                `Workflow structured result failed validation: ${errors}`,
              );
          }
          if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
            throw new Error("Workflow agent result exceeds 1 MiB");
          if (!failedAgent) state.cache[key] = result;
          if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) {
            delete state.cache[key];
            throw new Error("Workflow state exceeds 8 MiB");
          }
          await save(runId, state);
          send(id, result);
        } catch (error) {
          send(id, undefined, (error as Error).message);
        } finally {
          active--;
          queue.shift()?.();
        }
      }
      worker.on("message", (message: Record<string, unknown>) => {
        if (finished) return;
        try {
          if (message.type === "result") {
            const raw = String(message.raw);
            if (Buffer.byteLength(raw) > 1024 * 1024)
              throw new Error("Workflow result exceeds 1 MiB");
            state.result = JSON.parse(raw);
            void finish("completed");
          } else if (message.type === "error")
            void finish("failed", String(message.error));
          else if (message.type === "rpc") {
            const request = JSON.parse(String(message.raw)) as Record<
              string,
              unknown
            >;
            if (request.kind === "agent") void call(request);
            else if (request.kind === "result") {
              state.result = request.value;
              void finish("completed");
            } else if (request.kind === "error") {
              void finish("failed", String(request.message));
            } else {
              const text = String(request.message);
              if (state.logs.length >= 1000 || text.length > 4096)
                throw new Error("Workflow log limit exceeded");
              state.logs.push(`${request.kind}: ${text}`);
            }
          }
        } catch (error) {
          void finish("failed", (error as Error).message);
        }
      });
      worker.once("error", (error) => {
        void finish("failed", error.message);
      });
      worker.once("exit", (code) => {
        if (!finished) void finish("failed", `Workflow worker exited ${code}`);
      });
      if (options.signal?.aborted) abort();
      return launch;
    },
    close: async () => {
      closed = true;
      await Promise.all([...running.values()].map((launch) => launch.stop()));
    },
  };
}
