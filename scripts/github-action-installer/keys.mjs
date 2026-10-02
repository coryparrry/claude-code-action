import { readFile } from "node:fs/promises";

export function validateApiKey(value) {
  if (typeof value !== "string" || !/^sk-[A-Za-z0-9_-]{17,}$/.test(value))
    throw new Error(
      "Provide an OpenAI API key, without the OPENAI_API_KEY= prefix.",
    );
  return value;
}

export async function readKeyFile(filename) {
  let content;
  try {
    content = await readFile(filename, "utf8");
  } catch {
    throw new Error("Could not read the selected key file.");
  }
  const line = content.match(
    /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*$/m,
  );
  let key = (line ? line[1] : content).trim();
  if (key.startsWith('"')) {
    try {
      key = JSON.parse(key);
    } catch {
      throw new Error("The key file has an invalid quoted value.");
    }
  } else if (key.startsWith("'")) {
    if (!key.endsWith("'"))
      throw new Error("The key file has an invalid quoted value.");
    key = key.slice(1, -1);
  } else {
    key = key.replace(/\s+#.*$/, "").trim();
  }
  return validateApiKey(key);
}
