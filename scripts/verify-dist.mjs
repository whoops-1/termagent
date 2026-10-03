import { access, readFile } from "node:fs/promises";

const required = [
  "dist/index.js",
  "dist/client/index.js",
  "dist/client/index.d.ts",
  "dist/protocol/index.js",
  "dist/protocol/index.d.ts",
];

for (const file of required) {
  try {
    await access(file);
  } catch {
    throw new Error(`Missing release artifact: ${file}`);
  }
}

const entrypoint = await readFile("dist/index.js", "utf8");

if (!entrypoint.startsWith("#!/usr/bin/env node")) {
  throw new Error("dist/index.js is missing the Node.js executable shebang");
}

console.log("Release artifacts verified.");
