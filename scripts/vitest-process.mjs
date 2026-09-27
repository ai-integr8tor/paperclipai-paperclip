import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The root workspace declares Vitest as a development dependency. Resolve its
// installed CLI rather than spawning pnpm's platform-specific command shim.
function installedVitestCli() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))),
    "vitest.mjs",
  );
}

export function spawnVitest(args, options, cliPath = installedVitestCli()) {
  return spawnSync(process.execPath, [cliPath, ...args], options);
}
