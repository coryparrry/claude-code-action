/** Enforce documentation coverage for the release qualification code. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "@babel/parser";

const files = [
  "scripts/release-qualification/live-runtime.ts",
  "scripts/audit-qualification-documentation.mjs",
];
const symbols = [];

/** Count named functions, methods and classes with attached documentation. */
function visit(node, file, inheritedComments = []) {
  if (!node || typeof node !== "object") return;
  const comments = [...inheritedComments, ...(node.leadingComments ?? [])];
  const named =
    (node.type === "FunctionDeclaration" && node.id?.name) ||
    (node.type === "ClassDeclaration" && node.id?.name) ||
    (["ClassMethod", "ClassPrivateMethod", "ObjectMethod"].includes(
      node.type,
    ) &&
      (node.key?.name ?? node.key?.value)) ||
    (node.type === "VariableDeclarator" &&
      ["ArrowFunctionExpression", "FunctionExpression"].includes(
        node.init?.type,
      ) &&
      node.id?.name);
  if (named) {
    symbols.push({
      file,
      name: String(named),
      documented: comments.some(
        (comment) =>
          comment.type === "CommentBlock" && comment.value.startsWith("*"),
      ),
    });
  }
  for (const [key, value] of Object.entries(node)) {
    if (["leadingComments", "trailingComments", "innerComments"].includes(key))
      continue;
    const inherited = [
      "ExportNamedDeclaration",
      "VariableDeclaration",
    ].includes(node.type)
      ? comments
      : [];
    if (Array.isArray(value)) {
      for (const child of value) visit(child, file, inherited);
    } else if (value && typeof value === "object")
      visit(value, file, inherited);
  }
}

for (const file of files) {
  visit(
    parse(await readFile(file, "utf8"), {
      sourceType: "module",
      plugins: ["typescript"],
    }),
    file,
  );
}
const documented = symbols.filter((symbol) => symbol.documented).length;
const coverage = symbols.length ? documented / symbols.length : 0;
console.log(
  JSON.stringify(
    {
      documented,
      total: symbols.length,
      coverage,
      undocumented: symbols.filter((symbol) => !symbol.documented),
    },
    null,
    2,
  ),
);
assert.ok(
  coverage >= 0.85,
  "Qualification code requires at least 85% documentation coverage",
);
