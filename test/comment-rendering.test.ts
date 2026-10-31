import { describe, expect, test } from "bun:test";
import { renderDetails } from "../src/github/operations/comments/render";
import { updateCommentBody } from "../src/github/operations/comment-logic";

describe("shared native comment rendering", () => {
  test("escapes disclosure labels and preserves the intended Markdown body", () => {
    const body = "- [x] Checked the input\n\n`src/input.ts`";
    const result = renderDetails('<img src="unexpected"> & findings', body);
    expect(result).toStartWith("<details>\n<summary>&lt;img");
    expect(result).toContain("&quot;unexpected&quot;");
    expect(result).toContain("&amp; findings</summary>");
    expect(result).toContain(body);
    expect(result).not.toContain("<img");
  });

  test("opens only the active step when requested", () => {
    expect(renderDetails("Reading files", "Observed output", true)).toStartWith(
      "<details open>",
    );
    expect(renderDetails("Completed step", "Observed output")).toStartWith(
      "<details>",
    );
  });

  test("failure comments keep diagnostics in one collapsed section", () => {
    const result = updateCommentBody({
      currentBody: "- [x] Read the patch",
      actionFailed: true,
      executionDetails: null,
      jobUrl: "https://github.com/owner/repo/actions/runs/1",
      errorDetails: "The output did not match the schema",
      triggerUsername: "owner",
    });
    expect(result).toContain("**Codex encountered an error**");
    expect(result).toContain("<details>\n<summary>Error details</summary>");
    expect(result).toContain("The output did not match the schema");
    expect(result).toContain("- [x] Read the patch");
    expect(result).not.toContain("<details open>");
  });
});
