/** Immutable paired tasks; expected outcomes stay outside each model's workspace. */
export type RoutingCase = {
  id: string;
  kind: "fix" | "review";
  path: string;
  source: string;
  request: string;
  check?: string;
  expected?: {
    category: string;
    from: number;
    to: number;
    explanation_pattern?: string;
  }[];
};

/** Cover routine edits, sensitive edits, edge cases, real defects and clean reviews. */
export const routingCases: RoutingCase[] = [
  {
    id: "fix-clamp",
    kind: "fix",
    path: "src/clamp.ts",
    source:
      "export function clamp(value: number, min: number, max: number) {\n  return Math.max(min, Math.max(max, value));\n}\n",
    request:
      "Fix clamp so it returns the value within inclusive min and max bounds. Preserve its API.",
    check:
      "assert.equal(m.clamp(-3,0,10),0); assert.equal(m.clamp(3,0,10),3); assert.equal(m.clamp(11,0,10),10); assert.equal(m.clamp(2,2,2),2);",
  },
  {
    id: "fix-median",
    kind: "fix",
    path: "src/median.ts",
    source:
      "export function median(values: number[]) {\n  const sorted = values.sort();\n  return sorted[Math.floor(sorted.length / 2)];\n}\n",
    request:
      "Fix median for numeric ordering, even-length input and empty input (return null). Do not mutate the caller's array. Preserve the API.",
    check:
      "const a=[20,3,10]; assert.equal(m.median(a),10); assert.deepEqual(a,[20,3,10]); assert.equal(m.median([4,1,3,2]),2.5); assert.equal(m.median([]),null); assert.equal(m.median([-4,-2]),-3);",
  },
  {
    id: "fix-pagination",
    kind: "fix",
    path: "src/pagination.ts",
    source:
      "export function paginate<T>(items: T[], page: number, size: number): T[] {\n  return items.slice(page * size, size);\n}\n",
    request:
      "Fix zero-based pagination. Return [] for negative or noninteger page and for nonpositive or noninteger size. Preserve input and API.",
    check:
      "const a=[1,2,3,4,5]; assert.deepEqual(m.paginate(a,1,2),[3,4]); assert.deepEqual(m.paginate(a,2,2),[5]); for(const [p,s] of [[-1,2],[0,0],[0,-1],[0.5,2],[0,1.5]]) assert.deepEqual(m.paginate(a,p,s),[]); assert.deepEqual(a,[1,2,3,4,5]);",
  },
  {
    id: "fix-authorization",
    kind: "fix",
    path: "src/auth/access.ts",
    source:
      "export function mayDelete(user: { id: string; admin: boolean } | null, owner: string) {\n  return user !== null || user!.id === owner || user!.admin;\n}\n",
    request:
      "Fix authorization: only the owner or an admin may delete. Anonymous callers must return false without throwing.",
    check:
      "assert.equal(m.mayDelete(null,'a'),false); assert.equal(m.mayDelete({id:'b',admin:false},'a'),false); assert.equal(m.mayDelete({id:'a',admin:false},'a'),true); assert.equal(m.mayDelete({id:'b',admin:true},'a'),true);",
  },
  {
    id: "fix-retry",
    kind: "fix",
    path: "src/retry.ts",
    source:
      "export async function retry<T>(operation: () => Promise<T>, attempts: number): Promise<T> {\n  for (let i=0; i<=attempts; i++) { try { return await operation(); } catch {} }\n  throw new Error('failed');\n}\n",
    request:
      "Fix retry: attempts is the total number of calls allowed. Require a positive integer before calling the operation. Return the first success; on exhaustion rethrow the exact last error object.",
    check:
      "let n=0; const e=new Error('original'); await assert.rejects(()=>m.retry(async()=>{n++;throw e},2),x=>x===e); assert.equal(n,2); assert.equal(await m.retry(async()=>42,1),42); for(const a of [0,-1,1.5]) { n=0; await assert.rejects(()=>m.retry(async()=>{n++;return 1},a)); assert.equal(n,0); }",
  },
  {
    id: "fix-zero-option",
    kind: "fix",
    path: "src/options.ts",
    source:
      "export function timeout(options: { timeout?: number | null }) {\n  return options.timeout || 5000;\n}\n",
    request:
      "Fix timeout defaulting: zero explicitly disables timeouts and must be preserved. Only null or undefined should use 5000. Preserve the API.",
    check:
      "assert.equal(m.timeout({timeout:0}),0); assert.equal(m.timeout({timeout:250}),250); assert.equal(m.timeout({timeout:null}),5000); assert.equal(m.timeout({}),5000);",
  },
  {
    id: "review-bounds",
    kind: "review",
    path: "src/item.ts",
    source:
      "export function item(values: string[], index: number): string | null {\n  if (index < 0 || index > values.length) return null;\n  return values[index];\n}\n",
    request:
      "Review this complete file. The contract returns null for an index outside the array. Report concrete defects only.",
    expected: [
      {
        category: "bounds",
        from: 2,
        to: 3,
        explanation_pattern: "length|equal|end of|one.past",
      },
      {
        category: "bounds",
        from: 2,
        to: 3,
        explanation_pattern: "integer|fraction|NaN|0[.]5",
      },
    ],
  },
  {
    id: "review-mutation",
    kind: "review",
    path: "src/ranking.ts",
    source:
      "/** Return ascending scores while preserving the caller's input. */\nexport function rank(scores: number[]) {\n  return scores.sort((a,b) => a-b);\n}\n",
    request:
      "Review this complete file against its documented contract. Report concrete defects only.",
    expected: [{ category: "input_mutation", from: 2, to: 3 }],
  },
  {
    id: "review-clean",
    kind: "review",
    path: "src/total.ts",
    source:
      "/** Sum finite numbers; callers guarantee finite inputs. Empty input returns zero. */\nexport function total(values: readonly number[]) {\n  return values.reduce((sum, value) => sum + value, 0);\n}\n",
    request:
      "Review this complete file against its documented contract. Do not report hypothetical requirements or style preferences.",
    expected: [],
  },
  {
    id: "review-authorization",
    kind: "review",
    path: "src/auth/remove.ts",
    source:
      "/** Only an authenticated owner can remove an entry. */\nexport function mayRemove(user: { id: string } | null, owner: string) {\n  return Boolean(user) || user!.id === owner;\n}\n",
    request:
      "Review this complete file against its documented contract. Group defects with the same underlying expression into one finding.",
    expected: [{ category: "authorization", from: 2, to: 3 }],
  },
  {
    id: "review-zero",
    kind: "review",
    path: "src/count.ts",
    source:
      "/** Undefined uses the default; zero is a valid explicit count. */\nexport function count(value: number | undefined) {\n  return value || 10;\n}\n",
    request:
      "Review this complete file against its documented contract. Report concrete defects only.",
    expected: [{ category: "defaulting", from: 2, to: 3 }],
  },
  {
    id: "review-clean-copy",
    kind: "review",
    path: "src/ordered.ts",
    source:
      "/** Return a numerically sorted copy of finite numbers. Callers guarantee all values are finite. Input may be empty and must remain unchanged. */\nexport function ordered(values: readonly number[]) {\n  return [...values].sort((a,b) => a-b);\n}\n",
    request:
      "Review this complete file against its documented contract. Do not invent additional requirements.",
    expected: [],
  },
];
