import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runProcessMock: vi.fn(), ensureCommandMock: vi.fn(async () => {}) }));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  describeAdapterExecutionTarget: () => "remote box",
  ensureAdapterExecutionTargetCommandResolvable: (...a: unknown[]) => (mocks.ensureCommandMock as (...x: unknown[]) => unknown)(...a),
  ensureAdapterExecutionTargetDirectory: async () => {},
  resolveAdapterExecutionTargetCwd: (_t: unknown, cwd: string, fallback: string) => cwd || fallback,
  runAdapterExecutionTargetProcess: (...a: unknown[]) => (mocks.runProcessMock as (...x: unknown[]) => unknown)(...a),
}));

import { testEnvironment } from "./test.js";

const fixture = (name: string) =>
  fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", name), "utf8");

function helloStdout(text: string) {
  return JSON.stringify({ schema_version: 1, stream: { kind: "session", id: "s" }, sequence: 1, record_type: "event", payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text, reason: null } });
}

describe("muse_local testEnvironment", () => {
  beforeEach(() => {
    mocks.runProcessMock.mockReset();
    mocks.ensureCommandMock.mockReset();
    mocks.ensureCommandMock.mockResolvedValue(undefined);
  });

  it("passes when the hello probe answers", async () => {
    mocks.runProcessMock.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: helloStdout("hello"), stderr: "" });
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" } } as never);
    expect(result.status).toBe("pass");
    expect(result.checks.map((c) => c.code)).toContain("muse_hello_probe_passed");
    const args = mocks.runProcessMock.mock.calls[0]![3] as string[];
    expect(args).toEqual(expect.arrayContaining(["exec", "--json", "--no-session-log", "--approval-mode", "never"]));
    const env = (mocks.runProcessMock.mock.calls[0]![4] as { env: Record<string, string> }).env;
    expect(env.TBH_CREDENTIAL_BACKEND).toBeUndefined();
  });

  it("warns with auth_required when the key is rejected", async () => {
    mocks.runProcessMock.mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, stdout: await fixture("exec-badkey.jsonl"), stderr: "" });
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" } } as never);
    const check = result.checks.find((c) => c.code === "muse_hello_probe_auth_required");
    expect(check?.level).toBe("warn");
    expect(check?.hint).toMatch(/muse login/);
    expect(result.status).toBe("warn");
  });

  it("errors when the command is missing and skips the probe", async () => {
    mocks.ensureCommandMock.mockRejectedValue(new Error("Command not found: muse"));
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" } } as never);
    expect(result.status).toBe("fail");
    expect(result.checks.map((c) => c.code)).toContain("muse_command_unresolvable");
    expect(mocks.runProcessMock).not.toHaveBeenCalled();
  });

  it("reports remote targets as unsupported", async () => {
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" }, executionTarget: { kind: "remote", transport: "ssh" } } as never);
    expect(result.checks.map((c) => c.code)).toContain("muse_remote_unsupported");
    expect(result.status).toBe("fail");
  });
});
