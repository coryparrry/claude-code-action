import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const scenario = process.env.BOUNDARY_CASE;
assert.ok(["recovery", "repeat-tool", "empty-failure"].includes(scenario));
const success = scenario === "recovery";
assert.equal(process.env.BOUNDARY_OUTCOME, success ? "success" : "failure");
assert.equal(process.env.BOUNDARY_CONCLUSION, success ? "success" : "failure");
assert.ok(
  process.env.BOUNDARY_REPORT,
  "The composite action must expose its execution report even when it fails",
);
const report = JSON.parse(await readFile(process.env.BOUNDARY_REPORT, "utf8"));
const result = report.at(-1);
assert.equal(result.type, "result");
assert.equal(result.is_error, !success);
assert.equal(result.subtype, success ? "success" : "error_during_execution");
assert.ok(!JSON.stringify(report).includes("offline-boundary-fixture-key"));
const requests = JSON.parse(
  await readFile(
    join(process.env.RUNNER_TEMP, "boundary-requests.json"),
    "utf8",
  ),
);
assert.equal(requests.length, scenario === "empty-failure" ? 2 : 3);
assert.equal(result.usage.input_tokens, requests.length * 10);
assert.equal(result.num_turns, requests.length);
if (scenario !== "empty-failure") {
  assert.equal(await readFile("boundary-review.txt", "utf8"), "posted once");
  assert.equal(requests[2].tool_choice, "none");
  assert.equal((requests[2].tools ?? []).length, 0);
}
console.log(`Composite action boundary verified: ${scenario}`);
