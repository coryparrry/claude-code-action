import type { Octokits } from "../api/client";
import type { FetchDataResult } from "./fetcher";
import type { ParsedGitHubContext } from "../context";
import { downloadCommentImages } from "../utils/image-downloader";

export type ContextImage = { id: string; url: string; path: string };

/** Process authorized direct-parent attachments and expose opaque IDs for bounded image reads. */
export async function enrichContextImages(
  data: FetchDataResult,
  context: ParsedGitHubContext,
  octokits: Octokits,
  download = downloadCommentImages,
): Promise<void> {
  data.imageUrlMap ??= new Map();
  const request = data.reviewRequest;
  let parentImages = new Map<string, string>();
  if (request?.parentBody && request.parentId && !request.parentUnavailable) {
    parentImages = await download(
      octokits,
      context.repository.owner,
      context.repository.repo,
      [
        {
          type: "review_comment",
          id: String(request.parentId),
          body: request.parentBody,
        },
      ],
    );
    for (const [url, path] of parentImages) data.imageUrlMap.set(url, path);
  }
  data.contextImages = [...data.imageUrlMap].map(([url, path], index) => ({
    id: `image-${index + 1}`,
    url,
    path,
  }));
  if (request)
    request.attachmentIds = data.contextImages
      .filter((image) => parentImages.has(image.url))
      .map((image) => image.id);
}
