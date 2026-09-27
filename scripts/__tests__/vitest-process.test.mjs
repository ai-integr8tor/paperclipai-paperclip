import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnVitest } from "../vitest-process.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = "packages/shared/src/validators/issue.test.ts";
const probeCli = fileURLToPath(new URL("./fixtures/vitest-cli-probe.mjs", import.meta.url));

test("the runner starts a Node CLI without a platform-specific shim", () => {
  const result = spawnVitest(["list", "example.test.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  }, probeCli);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["list", "example.test.ts"]);
});

let vitestInstalled = true;
try { import.meta.resolve("vitest/package.json"); }
catch { vitestInstalled = false; }
test("the installed Vitest CLI supports both list and run", { timeout: 120_000,
  skip: vitestInstalled ? false : "Vitest is not installed in the policy-only CI job" }, () => {
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
