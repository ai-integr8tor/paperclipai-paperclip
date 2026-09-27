import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnVitest } from "../vitest-process.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = "packages/shared/src/validators/issue.test.ts";

test("the test runner starts both Vitest list and run without a platform-specific shim", { timeout: 120_000 }, () => {
  for (const command of ["list", "run"]) {
    const result = spawnVitest([command, fixture, "--silent"], {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: "test" },
      encoding: "utf8",
      timeout: 90_000,
    });
    assert.equal(result.error, undefined, `${command} failed to start: ${result.error?.message}`);
    assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  }
});
