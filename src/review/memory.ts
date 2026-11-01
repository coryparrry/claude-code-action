import type { Octokits } from "../github/api/client";
import { retryGitHubRead } from "../github/api/retry";
import { GITHUB_SERVER_URL } from "../github/api/config";
import { redactSecrets } from "../github/utils/sanitizer";
import type { ReviewTarget } from "./publisher";

export type RememberedFinding = {
  id: string;
  path: string;
  body: string;
  url: string;
  resolved: boolean | null;
};

/** Recover action-owned finding IDs from modern, grouped and compact archived bodies. */
export function rememberedFromBody(
  body: string,
  source: Pick<RememberedFinding, "path" | "url" | "resolved">,
): RememberedFinding[] {
  const found = new Map<string, RememberedFinding>();
  const archive = body.match(
    /<!-- codex-action:memory:v1:([A-Za-z0-9+/=]+) -->/,
  );
  if (archive) {
    const records: unknown = JSON.parse(
      Buffer.from(archive[1]!, "base64").toString("utf8"),
    );
    if (!Array.isArray(records))
      throw new Error("Invalid archived review memory");
    for (const record of records) {
      if (
        !record ||
        typeof record.id !== "string" ||
        !/^[a-f0-9]{12}$/.test(record.id) ||
        typeof record.path !== "string" ||
        typeof record.body !== "string"
      )
        throw new Error("Invalid archived finding record");
      found.set(record.id, {
        ...source,
        id: record.id,
        path: record.path,
        body: record.body,
      });
    }
  }
  let previous = 0;
  for (const match of body.matchAll(
    /<!-- codex-action:finding:([a-f0-9]{12}) -->/g,
  )) {
    const id = match[1]!;
    if (!found.has(id))
      found.set(id, {
        ...source,
        id,
        body: redactSecrets(
          body.slice(Math.max(previous, match.index! - 1800), match.index),
        ).trim(),
      });
    previous = match.index! + match[0].length;
  }
  return [...found.values()];
}

/** Preserve compact finding evidence before replacing an old full overview with a link. */
export function renderReviewMemory(records: RememberedFinding[]): string {
  if (!records.length) return "";
  const compact = records.map(({ id, path, body }) => ({
    id,
    path: Buffer.from(path).subarray(0, 400).toString("utf8"),
    body: Buffer.from(body).subarray(0, 500).toString("utf8"),
  }));
  const encoded = Buffer.from(JSON.stringify(compact)).toString("base64");
  if (encoded.length > 50_000)
    throw new Error(
      "Historical finding memory exceeds the overview limit; original evidence was preserved",
    );
  return `\n\n<!-- codex-action:memory:v1:${encoded} -->`;
}

type ThreadPage = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: {
          isResolved: boolean;
          comments: {
            nodes: {
              body: string;
              path: string;
              url: string;
              author: { login: string; __typename: string } | null;
            }[];
          };
        }[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  } | null;
};

/** Load durable, PR-scoped memory from all prior bot findings, including resolved threads. */
export async function loadReviewMemory(
  graphql: Octokits["graphql"],
  target: ReviewTarget,
  priorReviews: { id: number; body: string }[] = [],
): Promise<RememberedFinding[]> {
  const findings = new Map<string, RememberedFinding>();
  for (const review of priorReviews) {
    for (const finding of rememberedFromBody(review.body, {
      path: "",
      url: `${GITHUB_SERVER_URL}/${target.owner}/${target.repo}/pull/${target.pull_number}#pullrequestreview-${review.id}`,
      resolved: null,
    }))
      findings.set(finding.id, finding);
  }
  let cursor: string | null = null;
  const cursors = new Set<string>();
  do {
    const response: ThreadPage = await retryGitHubRead(() =>
      graphql<ThreadPage>(
        `
          query (
            $owner: String!
            $repo: String!
            $number: Int!
            $cursor: String
          ) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                reviewThreads(first: 100, after: $cursor) {
                  nodes {
                    isResolved
                    comments(first: 1) {
                      nodes {
                        body
                        path
                        url
                        author {
                          login
                          __typename
                        }
                      }
                    }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }
        `,
        {
          owner: target.owner,
          repo: target.repo,
          number: target.pull_number,
          cursor,
        },
      ),
    );
    const page = response.repository?.pullRequest?.reviewThreads;
    if (!page || !Array.isArray(page.nodes))
      throw new Error(
        "Review memory could not be verified; no new review will be published",
      );
    for (const thread of page.nodes) {
      const comment = thread.comments.nodes[0];
      if (!comment?.author) continue;
      const login = comment.author.login.toLowerCase();
      const expected = target.author.toLowerCase();
      const own =
        login === expected ||
        (comment.author.__typename === "Bot" &&
          expected.endsWith("[bot]") &&
          login === expected.slice(0, -5));
      if (!own) continue;
      for (const finding of rememberedFromBody(comment.body, {
        path: comment.path,
        url: comment.url,
        resolved: thread.isResolved,
      })) {
        const previous = findings.get(finding.id);
        if (
          !previous ||
          previous.resolved === null ||
          (!thread.isResolved && previous.resolved)
        )
          findings.set(finding.id, finding);
      }
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor))
      throw new Error(
        "Review memory pagination is incomplete; no new review will be published",
      );
    cursors.add(cursor);
  } while (true);
  return [...findings.values()];
}
