import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The root workspace declares Vitest as a development dependency. Resolve its
// installed CLI rather than spawning pnpm's platform-specific command shim.
const vitestCli = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))),
  "vitest.mjs",
);

export function spawnVitest(args, options) {
  return spawnSync(process.execPath, [vitestCli, ...args], options);
}
