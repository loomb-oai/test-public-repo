import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outDir = resolve("build");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "build-info.json"),
  JSON.stringify(
    {
      package: "@loomb-oai/node-test",
      builtAt: new Date().toISOString()
    },
    null,
    2
  ) + "\n",
  "utf8"
);

console.log(`Wrote ${resolve(outDir, "build-info.json")}`);
