import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContextImage } from "../src/mcp/github-context-server";
import {
  formatContextImages,
  formatReviewRequest,
} from "../src/create-prompt/task-guidance";
import type { FetchDataResult } from "../src/github/data/fetcher";
import { enrichContextImages } from "../src/github/data/context-images";
import { mockPullRequestReviewCommentContext } from "./mockContext";
import type { Octokits } from "../src/github/api/client";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("prepared images outside the workspace use opaque IDs and native MCP image content", async () => {
  const root = await mkdtemp(join(tmpdir(), "prepared-image-"));
  roots.push(root);
  const path = join(root, "image.png");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Zf8AAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(path, png);
  const result = await readContextImage({ "image-1": path }, "image-1");
  expect(result.content[0]).toEqual({
    type: "image",
    data: png.toString("base64"),
    mimeType: "image/png",
  });
  for (const id of [path, "../image.png", "toString", "__proto__"])
    await expect(readContextImage({ "image-1": path }, id)).rejects.toThrow(
      "Unknown",
    );
  const prompt = formatContextImages({
    contextImages: [
      {
        id: "image-1",
        url: "https://github.com/user-attachments/assets/example",
        path,
      },
    ],
  } as FetchDataResult);
  expect(prompt).toContain("mcp__github_context__view_image");
  expect(prompt).toContain(path);
  expect(JSON.parse(prompt.split("\n")[1]!)).toEqual([
    {
      id: "image-1",
      url: "https://github.com/user-attachments/assets/example",
      reference: path,
    },
  ]);
  await writeFile(path, "<svg></svg>");
  await expect(
    readContextImage({ "image-1": path }, "image-1"),
  ).rejects.toThrow("Only PNG");
  await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1));
  await expect(
    readContextImage({ "image-1": path }, "image-1"),
  ).rejects.toThrow("size limit");
});

test("parent code remains literal while hidden prose is removed", () => {
  const body =
    'Prose <!-- hidden directive -->\n`<div title="keep"> <!-- literal -->`\n```html\n<div onclick="literal()"><!-- code --></div>\n```\n~~~html\n<!-- tilde code -->\n~~~\n';
  const formatted = formatReviewRequest({
    reviewRequest: { parentBody: body, diffHunk: '<div onclick="literal()">' },
  } as FetchDataResult);
  const decoded = JSON.parse(formatted.split("\n").slice(1, -1).join("\n"));
  expect(decoded.parentBody).not.toContain("hidden directive");
  expect(decoded.parentBody).toContain('`<div title="keep"> <!-- literal -->`');
  expect(decoded.parentBody).toContain(
    '<div onclick="literal()"><!-- code --></div>',
  );
  expect(decoded.parentBody).toContain("<!-- tilde code -->");
  expect(decoded.diffHunk).toBe('<div onclick="literal()">');
});

test("out-of-page parent attachments join the prepared image set after parent fetching", async () => {
  const url = "https://github.com/user-attachments/assets/parent";
  const data = {
    imageUrlMap: new Map([["existing", "/tmp/existing.png"]]),
    reviewRequest: {
      parentId: 17,
      parentBody: `![example](${url})`,
      parentUnavailable: false,
    },
  } as FetchDataResult;
  const requests: unknown[] = [];
  /** Return prepared parent images without making external requests. */
  const download = async (
    ...args: Parameters<
      typeof import("../src/github/utils/image-downloader").downloadCommentImages
    >
  ) => {
    requests.push(args[3]);
    return new Map([[url, "/tmp/parent.png"]]);
  };
  await enrichContextImages(
    data,
    mockPullRequestReviewCommentContext,
    {} as Octokits,
    download,
  );
  expect(requests).toEqual([
    [{ type: "review_comment", id: "17", body: `![example](${url})` }],
  ]);
  expect(data.reviewRequest?.attachmentIds).toEqual(["image-2"]);
  expect(data.contextImages?.[1]).toEqual({
    id: "image-2",
    url,
    path: "/tmp/parent.png",
  });
  data.reviewRequest!.parentUnavailable = true;
  await enrichContextImages(
    data,
    mockPullRequestReviewCommentContext,
    {} as Octokits,
    download,
  );
  expect(requests).toHaveLength(1);
  expect(data.reviewRequest?.attachmentIds).toEqual([]);
});

test("hidden comments cannot expose directives by wrapping Markdown code delimiters", () => {
  for (const hidden of [
    "<!--\n```\nhidden directive\n```\n-->",
    "<!-- `hidden directive` -->",
    "<!--\n~~~html\nhidden directive\n~~~\n-->",
  ]) {
    const formatted = formatReviewRequest({
      reviewRequest: { parentBody: `Visible\n${hidden}\nTail` },
    } as FetchDataResult);
    expect(formatted).not.toContain("hidden directive");
    expect(formatted).toContain("Visible");
    expect(formatted).toContain("Tail");
  }
});
