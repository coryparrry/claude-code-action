import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPermissions } from "../src/agent-permissions";
import { createAgentLsp, type AgentLspOptions } from "../src/agent-lsp";
const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];
const fixture = `
const fs = require('node:fs');
let buffer = Buffer.alloc(0), documents = new Map(), editAllowed, pendingHover, initializeParams, serverSettings;
const send = message => {const body=JSON.stringify({jsonrpc:'2.0',...message});process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body)};
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const n=Number(/Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+n)return;const msg=JSON.parse(buffer.subarray(end+4,end+4+n));buffer=buffer.subarray(end+4+n);
if(msg.method==='initialize'){initializeParams=msg.params;if(process.env.PARENT_ONLY_SECRET)throw Error('inherited secret');if(process.env.FIXTURE_MARKER!=='explicit')throw Error('missing explicit env');send({id:msg.id,result:{capabilities:{textDocumentSync:1,definitionProvider:true}}});}
else if(msg.method==='workspace/didChangeConfiguration')serverSettings=msg.params.settings;
else if(msg.method==='textDocument/didOpen')documents.set(msg.params.textDocument.uri,msg.params.textDocument);
else if(msg.method==='textDocument/didChange'){const doc=documents.get(msg.params.textDocument.uri);doc.text=msg.params.contentChanges[0].text;doc.version=msg.params.textDocument.version;}
else if(msg.method==='textDocument/hover'){pendingHover=msg;send({id:'edit',method:'workspace/applyEdit',params:{edit:{changes:{}}}});}
else if(msg.id==='edit'){editAllowed=msg.result.applied;send({method:'textDocument/publishDiagnostics',params:{uri:pendingHover.params.textDocument.uri,diagnostics:[{message:'fixture diagnostic',severity:2}]}});send({id:pendingHover.id,result:{contents:'hover',applied:editAllowed,document:documents.get(pendingHover.params.textDocument.uri),position:pendingHover.params.position,initializeParams,serverSettings}});}
else if(msg.method==='textDocument/prepareCallHierarchy')send({id:msg.id,result:[{name:'item',uri:msg.params.textDocument.uri}]});
else if(msg.method==='callHierarchy/incomingCalls'||msg.method==='callHierarchy/outgoingCalls')send({id:msg.id,result:[{name:msg.method}]});
else if(msg.method==='shutdown'){send({id:msg.id,result:null});}
else if(msg.method==='exit')process.exit(0);
else if(msg.id!==undefined)send({id:msg.id,result:{method:msg.method,params:msg.params,documents:[...documents.values()]}});
}});
`;
async function setup(
  overrides: Partial<AgentLspOptions> = {},
  script = fixture,
) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agent-lsp-")));
  directories.push(cwd);
  const server = join(cwd, "server.cjs");
  await writeFile(server, script);
  await writeFile(join(cwd, "file.ts"), "const value = 1\n");
  const options: AgentLspOptions = {
    cwd,
    env: { FIXTURE_MARKER: "explicit" },
    servers: {
      fixture: {
        command: process.execPath,
        args: [server],
        extensionToLanguage: { ".ts": "typescript" },
      },
    },
    permissions: new AgentPermissions({ cwd, allowedTools: ["LSP"] }),
    requestTimeoutMs: 500,
    ...overrides,
  };
  const lsp = createAgentLsp(options);
  closers.push(lsp.close);
  return { cwd, options, lsp };
}
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("stdio language-server adapter", () => {
  test("real JSON-RPC initializes, opens document and sends zero-based definition/reference/symbol requests", async () => {
    const previous = process.env.PARENT_ONLY_SECRET;
    process.env.PARENT_ONLY_SECRET = "must-not-inherit";
    try {
      const { lsp } = await setup();
      const definition = (await lsp.execute({
        operation: "goToDefinition",
        filePath: "file.ts",
        line: 2,
        character: 3,
      })) as Record<string, any>;
      expect(definition.method).toBe("textDocument/definition");
      expect(definition.params.position).toEqual({ line: 1, character: 2 });
      expect(definition.documents[0].text).toBe("const value = 1\n");
      const references = (await lsp.execute({
        operation: "findReferences",
        filePath: "file.ts",
      })) as Record<string, any>;
      expect(references.params.context.includeDeclaration).toBe(true);
      const symbols = (await lsp.execute({
        operation: "workspaceSymbol",
        filePath: "file.ts",
        query: "value",
      })) as Record<string, any>;
      expect(symbols.params.query).toBe("value");
      const documentSymbols = (await lsp.execute({
        operation: "documentSymbol",
        filePath: "file.ts",
      })) as Record<string, any>;
      expect(documentSymbols.method).toBe("textDocument/documentSymbol");
      const implementation = (await lsp.execute({
        operation: "goToImplementation",
        filePath: "file.ts",
      })) as Record<string, any>;
      expect(implementation.method).toBe("textDocument/implementation");
    } finally {
      if (previous === undefined) delete process.env.PARENT_ONLY_SECRET;
      else process.env.PARENT_ONLY_SECRET = previous;
    }
  });
  test("refreshes changed documents and refuses server-initiated edits", async () => {
    const { cwd, lsp } = await setup();
    const first = (await lsp.execute({
      operation: "hover",
      filePath: "file.ts",
    })) as Record<string, any>;
    expect(first.applied).toBe(false);
    await writeFile(join(cwd, "file.ts"), "changed\n");
    await lsp.notifyFileChanged("file.ts");
    const second = (await lsp.execute({
      operation: "hover",
      filePath: "file.ts",
    })) as Record<string, any>;
    expect(second.document.text).toBe("changed\n");
    expect(second.document.version).toBe(2);
    expect(await readFile(join(cwd, "file.ts"), "utf8")).toBe("changed\n");
    expect(
      await lsp.execute({ operation: "incomingCalls", filePath: "file.ts" }),
    ).toEqual([{ name: "callHierarchy/incomingCalls" }]);
    expect(
      await lsp.execute({ operation: "outgoingCalls", filePath: "file.ts" }),
    ).toEqual([{ name: "callHierarchy/outgoingCalls" }]);
  });
  test("socket manifests use stdio, configured settings/workspace reach server and diagnostics drain", async () => {
    const { cwd, options } = await setup();
    const lsp = createAgentLsp({
      ...options,
      servers: {
        fixture: {
          command: process.execPath,
          args: [join(cwd, "server.cjs")],
          extensionToLanguage: { ".ts": "typescript" },
          transport: "socket",
          settings: { typescript: { strict: true } },
          workspaceFolder: "configured-folder",
        },
      },
    });
    closers.push(lsp.close);
    const result = (await lsp.execute({
      operation: "hover",
      filePath: "file.ts",
    })) as Record<string, any>;
    expect(result.serverSettings).toEqual({ typescript: { strict: true } });
    expect(result.initializeParams.rootUri).toContain("configured-folder");
    expect(lsp.drainDiagnostics().join("\n")).toContain("fixture diagnostic");
    expect(lsp.drainDiagnostics()).toEqual([]);
    const disabled = createAgentLsp({
      ...options,
      servers: {
        fixture: {
          command: process.execPath,
          args: [join(cwd, "server.cjs")],
          extensionToLanguage: { ".ts": "typescript" },
          diagnostics: false,
        },
      },
    });
    closers.push(disabled.close);
    await disabled.execute({ operation: "hover", filePath: "file.ts" });
    expect(disabled.drainDiagnostics()).toEqual([]);
  });
  test("configured crash restart retries the read-only query and can be disabled", async () => {
    const crashing =
      "const marker=require('node:path').join(process.cwd(),'crashed');const existed=require('node:fs').existsSync(marker);" +
      fixture.replace(
        "else if(msg.method==='textDocument/hover'){",
        "else if(msg.method==='textDocument/hover'){if(!existed){fs.writeFileSync(marker,'yes');process.exit(1)}",
      );
    const { lsp } = await setup({}, crashing);
    const results = (await Promise.all([
      lsp.execute({ operation: "hover", filePath: "file.ts" }),
      lsp.execute({ operation: "hover", filePath: "file.ts" }),
    ])) as Record<string, any>[];
    expect(results.map((result) => result.contents)).toEqual([
      "hover",
      "hover",
    ]);
    const other = await setup({}, crashing);
    const disabled = createAgentLsp({
      ...other.options,
      servers: {
        fixture: {
          command: process.execPath,
          args: [join(other.cwd, "server.cjs")],
          extensionToLanguage: { ".ts": "typescript" },
          restartOnCrash: false,
        },
      },
    });
    closers.push(disabled.close);
    await expect(
      disabled.execute({ operation: "hover", filePath: "file.ts" }),
    ).rejects.toThrow("exited");
  });
  test("permission denials, outside paths, missing language and invalid positions fail before spawn", async () => {
    const { cwd, lsp } = await setup();
    await expect(
      lsp.execute({ operation: "hover", filePath: "../outside.ts" }),
    ).rejects.toThrow("outside");
    await expect(
      lsp.execute({ operation: "hover", filePath: "file.ts", line: 0 }),
    ).rejects.toThrow("positive");
    await writeFile(join(cwd, "file.txt"), "text");
    await expect(
      lsp.execute({ operation: "hover", filePath: "file.txt" }),
    ).rejects.toThrow("No configured");
    const denied = createAgentLsp({
      cwd,
      env: {},
      servers: {},
      permissions: new AgentPermissions({ cwd, disallowedTools: ["LSP"] }),
    });
    closers.push(denied.close);
    await expect(
      denied.execute({ operation: "hover", filePath: "file.ts" }),
    ).rejects.toThrow("denied");
    expect(() =>
      createAgentLsp({
        cwd,
        env: {},
        servers: {
          bad: {
            command: "server",
            transport: "unsupported",
            extensionToLanguage: { ".ts": "typescript" },
          },
        },
        permissions: new AgentPermissions({ cwd }),
      }),
    ).toThrow("stdio");
  });
  test("unresponsive initialization times out, malformed frames fail and close prevents future calls", async () => {
    const hung = await setup(
      { requestTimeoutMs: 20 },
      "process.stdin.resume();setInterval(()=>{},1000)",
    );
    // Run deadline clips initialization even when its configured timeout is larger.
    const deadline = createAgentLsp({
      ...hung.options,
      deadline: Date.now() + 30,
      servers: {
        fixture: {
          command: process.execPath,
          args: [join(hung.cwd, "server.cjs")],
          extensionToLanguage: { ".ts": "typescript" },
        },
      },
    });
    closers.push(deadline.close);
    await expect(
      deadline.execute({ operation: "hover", filePath: "file.ts" }),
    ).rejects.toThrow("timed out");
    const malformed = await setup(
      {},
      "process.stdout.write('Content-Length: 99999999\\r\\n\\r\\n');process.stdin.resume()",
    );
    await expect(
      malformed.lsp.execute({ operation: "hover", filePath: "file.ts" }),
    ).rejects.toThrow("4 MiB");
    await malformed.lsp.close();
    await expect(
      malformed.lsp.execute({ operation: "hover", filePath: "file.ts" }),
    ).rejects.toThrow("closed");
  });
  test("per-tool cancellation kills pending initialization", async () => {
    const controller = new AbortController();
    const { lsp } = await setup(
      {},
      "process.stdin.resume();setInterval(()=>{},1000)",
    );
    const request = lsp.execute(
      { operation: "hover", filePath: "file.ts" },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);
    await expect(request).rejects.toThrow("cancelled");
  });
  test("parent cancellation kills the server and rejects pending calls", async () => {
    const controller = new AbortController();
    const { lsp } = await setup(
      { signal: controller.signal },
      "process.stdin.resume();setInterval(()=>{},1000)",
    );
    const request = lsp.execute({ operation: "hover", filePath: "file.ts" });
    setTimeout(() => controller.abort(), 25);
    await expect(request).rejects.toThrow("cancelled");
  });
});
