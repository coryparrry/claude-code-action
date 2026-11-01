import { readFile } from "node:fs/promises";
import { parse } from "@babel/parser";

const files = [
  "src/github/data/repository-memory.ts",
  "src/github/data/repository-memory-store.ts",
  "src/github/data/review-memory-candidate.ts",
  "src/github/operations/publish-review-memory.ts",
  "src/entrypoints/publish-review-memory.ts",
  "src/review/repository-learning.ts",
  "scripts/github-action-installer/workflow.mjs",
  "scripts/github-action-installer/install.mjs",
  "scripts/github-action-installer/github.mjs",
];
const functions = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassMethod",
  "ObjectMethod",
]);
const branches = new Set([
  "IfStatement",
  "ConditionalExpression",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
  "LogicalExpression",
  "AssignmentPattern",
]);

/** Traverse AST children once, excluding comments and location metadata. */
function children(node) {
  return Object.entries(node)
    .filter(
      ([key]) =>
        ![
          "loc",
          "leadingComments",
          "trailingComments",
          "innerComments",
          "comments",
        ].includes(key),
    )
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter(
      (value) =>
        value && typeof value === "object" && typeof value.type === "string",
    );
}

/** Count cyclomatic decisions per function, excluding decisions owned by nested functions. */
function complexity(root) {
  let count = 1;
  /** Attribute decisions to their owning function rather than nested callbacks. */
  function visit(node) {
    if (node !== root && functions.has(node.type)) return;
    if (
      branches.has(node.type) ||
      (node.type === "SwitchCase" && node.test) ||
      (["OptionalMemberExpression", "OptionalCallExpression"].includes(
        node.type,
      ) &&
        node.optional === true)
    )
      count++;
    children(node).forEach(visit);
  }
  visit(root);
  return count;
}

/** Enforce scoped production limits without adding a new linter dependency. */
export async function checkReviewComplexity() {
  const findings = [];
  const results = [];
  for (const file of files) {
    const source = await readFile(
      new URL(`../${file}`, import.meta.url),
      "utf8",
    );
    const lines = source.trimEnd().split("\n").length;
    if (lines > 500) findings.push(`${file}: ${lines} lines exceeds 500`);
    const ast = parse(source, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    /** Record each function independently, including callbacks. */
    function visit(node, parent) {
      if (functions.has(node.type)) {
        const name =
          node.id?.name ??
          node.key?.name ??
          parent?.id?.name ??
          `callback:${node.loc.start.line}`;
        const score = complexity(node);
        results.push({
          file,
          name,
          line: node.loc.start.line,
          complexity: score,
        });
        if (score > 15)
          findings.push(
            `${file}:${node.loc.start.line} ${name}: complexity ${score} exceeds 15`,
          );
      }
      children(node).forEach((child) => visit(child, node));
    }
    visit(ast);
  }
  console.log(
    JSON.stringify(
      {
        files: files.length,
        functions: results.length,
        maxComplexity: Math.max(...results.map((result) => result.complexity)),
        mostComplex: results
          .sort((a, b) => b.complexity - a.complexity)
          .slice(0, 8),
        failures: findings,
      },
      null,
      2,
    ),
  );
  if (findings.length) process.exitCode = 1;
}

if (import.meta.main) await checkReviewComplexity();
