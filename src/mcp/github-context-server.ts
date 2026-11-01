import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** Read only a prepared attachment, returning native image content without opening a directory scope. */
export async function readContextImage(
  images: Record<string, string>,
  id: string,
) {
  if (!Object.hasOwn(images, id))
    throw new Error("Unknown prepared attachment ID");
  const data = await readFile(images[id]!);
  if (data.length > 10 * 1024 * 1024)
    throw new Error("Attachment exceeds the image size limit");
  const header = data.subarray(0, 16);
  const mimeType = header
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : header[0] === 255 && header[1] === 216
      ? "image/jpeg"
      : /^GIF8[79]a/.test(header.toString("ascii"))
        ? "image/gif"
        : header.subarray(0, 4).toString() === "RIFF" &&
            header.subarray(8, 12).toString() === "WEBP"
          ? "image/webp"
          : undefined;
  if (!mimeType)
    throw new Error("Only PNG, JPEG, GIF and WebP attachments are supported");
  return {
    content: [
      { type: "image" as const, data: data.toString("base64"), mimeType },
    ],
  };
}

/** Serve the immutable allowlist of attachments downloaded during trusted preparation. */
export async function runContextServer() {
  const images = JSON.parse(process.env.GITHUB_IMAGE_PATHS || "{}") as Record<
    string,
    string
  >;
  const server = new McpServer({
    name: "GitHub Context Server",
    version: "1.0.0",
  });
  server.tool(
    "view_image",
    "View a prepared GitHub attachment by its opaque ID; arbitrary file paths and URLs are not accepted",
    { id: z.string() },
    async ({ id }) => {
      try {
        return await readContextImage(images, id);
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );
  await server.connect(new StdioServerTransport());
}

if (import.meta.main)
  runContextServer().catch(() => {
    process.exitCode = 1;
  });
