import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const [scenario, endpointFile] = process.argv.slice(2);
if (
  !["recovery", "repeat-tool", "empty-failure"].includes(scenario) ||
  !endpointFile
)
  throw new Error("Expected a boundary scenario and endpoint file");
const message = (text) => [
  {
    id: "message-fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  },
];
const write = (content, id) => [
  {
    id: `function-${id}`,
    type: "function_call",
    name: "Write",
    call_id: id,
    status: "completed",
    arguments: JSON.stringify({ file_path: "boundary-review.txt", content }),
  },
];
const replies =
  scenario === "empty-failure"
    ? [message(""), message(" ")]
    : [
        write("posted once", "first-write"),
        message(""),
        scenario === "recovery"
          ? message("Review complete")
          : write("duplicate", "second-write"),
      ];
const requests = [];
const server = createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    await writeFile(
      join(process.env.RUNNER_TEMP, "boundary-requests.json"),
      JSON.stringify(requests),
    );
    const output = replies[requests.length - 1];
    response.setHeader("content-type", "application/json");
    if (!output) {
      response.writeHead(400).end(
        JSON.stringify({
          error: {
            message: "Unexpected model request",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        id: `response-${requests.length}`,
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-6-luna",
        output,
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }),
    );
  } catch (error) {
    response
      .writeHead(500)
      .end(JSON.stringify({ error: { message: error.message } }));
  }
});
server.listen(0, "127.0.0.1", async () => {
  await writeFile(endpointFile, `http://127.0.0.1:${server.address().port}/v1`);
});
