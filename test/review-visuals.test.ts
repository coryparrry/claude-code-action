import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  renderReviewHeading,
  renderRiskDetails,
  renderScopeDetails,
  REVIEW_ASSET_REVISION,
} from "../src/review/visuals";

describe("repository-hosted review graphics", () => {
  test("every emitted image has light/dark assets and safe, standalone SVG content", async () => {
    const markup = [
      renderReviewHeading("walkthrough"),
      renderReviewHeading("changes"),
      renderReviewHeading("flow"),
      ...(["low", "moderate", "high"] as const).map((level) =>
        renderRiskDetails(level, "Inspection evidence"),
      ),
      renderScopeDetails("Reviewed scope"),
    ].join("\n");
    const images = [...markup.matchAll(/(?:srcset|src)="([^"]+)"/g)];
    expect(images).toHaveLength(16);
    for (const [, source] of images) {
      const url = new URL(source!);
      expect(url.origin).toBe("https://raw.githubusercontent.com");
      expect(url.pathname).toStartWith(
        `/coryparrry/claude-code-action/${REVIEW_ASSET_REVISION}/assets/review/`,
      );
      expect(url.search).toBe("");
      const name = url.pathname.split("/").at(-1)!;
      expect(name).toMatch(/^[a-z-]+-(light|dark)\.svg$/);
      const svg = await readFile(
        new URL(`../assets/review/${name}`, import.meta.url),
        "utf8",
      );
      // An embedded SVG cannot inherit the surrounding page's text color.
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toMatch(/#[a-f0-9]{6}/);
      expect(svg).not.toMatch(
        /currentColor|<script|foreignObject|href=|onload=|url\(/i,
      );
      expect(
        [...svg.matchAll(/<\/?([\w:]+)/g)].every((match) =>
          ["svg", "title", "g", "path", "circle", "rect", "text"].includes(
            match[1]!,
          ),
        ),
      ).toBe(true);
    }
    expect(markup.match(/prefers-color-scheme: dark/g)).toHaveLength(8);
    expect(REVIEW_ASSET_REVISION).toMatch(/^[a-f0-9]{40}$/);
  });

  test("labels remain readable when images are blocked and never imply executed checks", () => {
    const heading = renderReviewHeading("walkthrough");
    expect(heading).toContain(" Walkthrough ");
    expect(heading).toContain('alt="Code inspection"');
    for (const level of ["low", "moderate", "high"] as const) {
      const details = renderRiskDetails(level, "Static inspection only.");
      expect(details).toStartWith("<details>\n<summary>");
      expect(details).toContain("Merge risk");
      expect(details).toContain(
        `alt="${level[0]!.toUpperCase()}${level.slice(1)}"`,
      );
      expect(details).toContain("Static inspection only.");
      expect(details).not.toMatch(
        /passed|approved|checks|<table|<details open/i,
      );
    }
    expect(renderScopeDetails("Evidence")).toContain(
      " Review scope &amp; verification</summary>",
    );
  });
});
