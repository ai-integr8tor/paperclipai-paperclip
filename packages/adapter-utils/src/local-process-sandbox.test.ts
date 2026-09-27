import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLocalProcessSandboxSpawnTarget,
  parseLocalProcessFilesystemScope,
  parseLocalProcessNetworkAllowlist,
  parseLocalProcessNetworkScope,
  parseLocalProcessSandboxExtraPaths,
  SANDBOX_NETWORK_EVENT_SCHEMA_VERSION,
  type SandboxNetworkDecision,
  type SandboxNetworkEvent,
  type SandboxNetworkProxyStarted,
  type SandboxNetworkProxyStopped,
  type SandboxNetworkTunnelClosed,
} from "./local-process-sandbox.js";
import { runChildProcess } from "./server-utils.js";

const cleanup: string[] = [];

function decisionEvents(events: SandboxNetworkEvent[]): SandboxNetworkDecision[] {
  return events.filter((event): event is SandboxNetworkDecision => event.event === "sandbox.network.decision");
}

function startedEvents(events: SandboxNetworkEvent[]): SandboxNetworkProxyStarted[] {
  return events.filter((event): event is SandboxNetworkProxyStarted => event.event === "sandbox.network.proxy.started");
}

function stoppedEvents(events: SandboxNetworkEvent[]): SandboxNetworkProxyStopped[] {
  return events.filter((event): event is SandboxNetworkProxyStopped => event.event === "sandbox.network.proxy.stopped");
}

function tunnelEvents(events: SandboxNetworkEvent[]): SandboxNetworkTunnelClosed[] {
  return events.filter((event): event is SandboxNetworkTunnelClosed => event.event === "sandbox.network.tunnel.closed");
}

/** Reads the proxy socket path out of the bridge argv the sandbox builder produced. */
function proxySocketPath(args: string[]): string {
  return args[args.indexOf("--") + 3];
}

function connectThroughProxy(socketPath: string, requestLine: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      socket.end(`CONNECT ${requestLine} HTTP/1.1\r\nHost: ${requestLine}\r\n\r\n`);
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

/**
 * Same request as {@link connectThroughProxy}, but resolves with whatever arrived by the deadline
 * instead of waiting for the proxy to close the socket. A proxy that dies mid-handler never answers
 * and never ends the connection, so the plain helper would hang rather than report; this one lets the
 * assertions run against the silence. The deadline stays well inside the suite's test timeout so a
 * dead proxy fails on the assertion that names the cause, not on a timeout that names nothing.
 */
function connectThroughProxyWithDeadline(socketPath: string, requestLine: string, deadlineMs = 1000): Promise<string> {
  return new Promise<string>((resolve) => {
    let response = "";
    const socket = net.createConnection(socketPath, () => {
      socket.end(`CONNECT ${requestLine} HTTP/1.1\r\nHost: ${requestLine}\r\n\r\n`);
    });
    socket.setEncoding("utf8");
    const finish = (): void => {
      clearTimeout(deadline);
      socket.destroy();
      resolve(response);
    };
    const deadline = setTimeout(finish, deadlineMs);
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", finish);
    socket.on("error", finish);
  });
}

/**
 * Observes uncaught exceptions rather than inheriting them. The proxy's `http.Server` runs in this
 * process, so a synchronous throw inside its `connect` handler is an uncaught exception in the test
 * worker — it kills the run instead of failing an assertion, which is the difference between a
 * readable regression and a mystery. Vitest's own handlers are parked for the duration and restored
 * in `finally`, so a genuine crash elsewhere still reports normally.
 */
async function captureUncaughtExceptions<T>(run: () => Promise<T>): Promise<{ result: T; uncaught: Error[] }> {
  const uncaught: Error[] = [];
  const parked = process.listeners("uncaughtException");
  for (const listener of parked) process.off("uncaughtException", listener);
  const capture = (error: Error): void => { uncaught.push(error); };
  process.on("uncaughtException", capture);
  try {
    return { result: await run(), uncaught };
  } finally {
    process.off("uncaughtException", capture);
    for (const listener of parked) process.on("uncaughtException", listener);
  }
}

async function withTmpDir<T>(tmpDir: string, run: () => Promise<T>): Promise<T> {
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = tmpDir;
  try {
    return await run();
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

describe("local process sandbox", () => {
  it.runIf(process.platform !== "linux")("rejects sandbox scopes on unsupported hosts", async () => {
    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd(),
      options: { workspaceDir: process.cwd(), networkScope: "deny" },
    })).rejects.toThrow("supported only on Linux");
  });

  it("parses read-only and writable extra paths", () => {
    expect(parseLocalProcessSandboxExtraPaths(["/opt/cache", { path: "/var/lib/tool", access: "rw" }])).toEqual([
      { path: "/opt/cache", access: "ro" },
      { path: "/var/lib/tool", access: "rw" },
    ]);
    expect(() => parseLocalProcessSandboxExtraPaths(["relative"])).toThrow("must be an absolute path");
  });

  it("parses network scopes and exact-host allowlists", () => {
    expect(parseLocalProcessFilesystemScope("workspace")).toBe("workspace");
    expect(parseLocalProcessFilesystemScope(undefined)).toBeNull();
    expect(() => parseLocalProcessFilesystemScope("workpace")).toThrow('filesystemScope must be "workspace"');
    expect(parseLocalProcessNetworkScope("deny")).toBe("deny");
    expect(parseLocalProcessNetworkScope("allowlist")).toBe("allowlist");
    expect(parseLocalProcessNetworkScope(undefined)).toBeNull();
    expect(parseLocalProcessNetworkAllowlist(["api.openai.com", "https://api.anthropic.com", "gateway.test:8443"]))
      .toEqual(["api.openai.com", "api.anthropic.com", "gateway.test:8443"]);
    expect(() => parseLocalProcessNetworkAllowlist(["*.example.com"])).toThrow("exact hostname");
    expect(() => parseLocalProcessNetworkScope("public")).toThrow('"deny" or "allowlist"');
  });

  it.runIf(process.platform === "linux")("describes every valid allowlist input when no proxy rules remain", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-rules-"));
    cleanup.push(workspace);

    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: [],
        networkTrustedUrls: ["file:///not-a-network-target"],
      },
    })).rejects.toThrow("valid networkAllowlist hostname or HTTP(S) networkTrustedUrl");
  });

  it.runIf(process.platform === "linux")("builds a fresh-root bubblewrap command with workspace access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const managedHome = path.join(root, "managed-home");
    await fs.mkdir(workspace);
    await fs.mkdir(managedHome);

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        managedPaths: [{ path: managedHome, access: "rw" }],
        homeDir: managedHome,
      },
    });

    expect(target.command).toBe("bwrap");
    expect(target.args).toContain("--tmpfs");
    expect(target.args).toContain(workspace);
    expect(target.args).toContain(managedHome);
    expect(target.args.slice(-3)).toEqual([process.execPath, "-e", "console.log('ok')"]);
  });

  it.runIf(process.platform === "linux")("binds a confined absolute alias to the synchronized workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-alias-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        pathAliases: [{ path: "/app", target: workspace }],
      },
    });

    expect(target.args).toEqual(expect.arrayContaining(["--bind", workspace, "/app"]));
  });

  it.runIf(process.platform === "linux")("rejects writable out-of-tree paths without an outbound restore mapping", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-outbound-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);

    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        extraPaths: [{ path: outside, access: "rw" }],
      },
    })).rejects.toThrow("has no outbound restore mapping");
  });

  it.runIf(process.platform === "linux")("builds a network-only namespace without changing filesystem visibility", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-sandbox-"));
    cleanup.push(workspace);
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: workspace,
      options: { workspaceDir: workspace, networkScope: "deny" },
    });

    expect(target.args).toContain("--unshare-net");
    expect(target.args).toContain("--bind");
    expect(target.args).not.toContain("--tmpfs");
    expect(target.env?.HTTP_PROXY).toBeUndefined();
  });

  it.runIf(process.platform === "linux")("forwards allowed proxy targets with a deep TMPDIR and rejects other hosts", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-proxy-"));
    cleanup.push(workspace);
    const deepTmpDir = path.join(workspace, ...Array.from({ length: 6 }, () => "deep-temporary-directory-segment"));
    await fs.mkdir(deepTmpDir, { recursive: true });
    const server = http.createServer((_request, response) => response.end("allowed-response"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
    const events: SandboxNetworkEvent[] = [];
    const target = await withTmpDir(deepTmpDir, () =>
      buildLocalProcessSandboxSpawnTarget({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: workspace,
        options: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          networkScope: "allowlist",
          networkAllowlist: [`127.0.0.1:${address.port}`],
          onNetworkDecision: (event) => events.push(event),
        },
      }),
    );
    const delimiterIndex = target.args.indexOf("--");
    const socketPath = target.args[delimiterIndex + 3];
    expect(Buffer.byteLength(path.join(deepTmpDir, "paperclip-network-sandbox-XXXXXX", "proxy.sock"))).toBeGreaterThan(107);
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(107);
    expect(socketPath).toMatch(/^\/tmp\/paperclip-network-sandbox-/);
    expect(target.args).toContain(path.dirname(socketPath));
    const request = (url: string) => new Promise<{ status: number; contentType: string | null; body: string }>((resolve, reject) => {
      const outgoing = http.request({ socketPath, path: url, headers: { host: new URL(url).host } }, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : null,
          body,
        }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });

    try {
      await expect(request(`http://127.0.0.1:${address.port}/canary`)).resolves.toEqual({
        status: 200,
        contentType: null,
        body: "allowed-response",
      });
      await expect(request("http://example.com/")).resolves.toEqual({
        status: 403,
        contentType: "application/json; charset=utf-8",
        body: '{"error":{"code":"network_target_denied","message":"Network target denied by Paperclip sandbox policy."}}\n',
      });
      const connectResponse = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
          socket.end("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
        });
        let response = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => { response += chunk; });
        socket.on("end", () => resolve(response));
        socket.on("error", reject);
      });
      expect(connectResponse).toContain("HTTP/1.1 403 Forbidden\r\n");
      expect(connectResponse).toContain("Content-Type: application/json; charset=utf-8\r\n");
      expect(connectResponse).toContain(
        '{"error":{"code":"network_target_denied","message":"Network target denied by Paperclip sandbox policy."}}\n',
      );

      // One structured decision per egress attempt, in order: allowed http, denied http, denied CONNECT.
      const decisions = decisionEvents(events);
      expect(decisions.map(({ ts, schemaVersion, ...event }) => event)).toEqual([
        {
          event: "sandbox.network.decision",
          decision: "allow",
          reason: "allowlist_match",
          hostname: "127.0.0.1",
          port: String(address.port),
          method: "GET",
          scheme: "http",
          hostnameSanitized: false,
          tunnelId: null,
        },
        {
          event: "sandbox.network.decision",
          decision: "deny",
          reason: "network_target_denied",
          hostname: "example.com",
          port: "80",
          method: "GET",
          scheme: "http",
          hostnameSanitized: false,
          tunnelId: null,
        },
        {
          event: "sandbox.network.decision",
          decision: "deny",
          reason: "network_target_denied",
          hostname: "example.com",
          port: "443",
          method: "CONNECT",
          scheme: null,
          hostnameSanitized: false,
          tunnelId: null,
        },
      ]);
      for (const event of decisions) {
        expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
      // The decision record must never carry request paths, query strings, headers or bodies.
      expect(JSON.stringify(decisions)).not.toMatch(/canary/);
      // The proxy announces itself before any decision, so an empty decision stream is never ambiguous.
      expect(events[0]).toMatchObject({
        event: "sandbox.network.proxy.started",
        allowlistEntryCount: 1,
        trustedUrlCount: 0,
        ruleCount: 1,
      });
      expect(startedEvents(events)[0].rulesetDigest).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      await target.cleanup?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Teardown closes the record: the counters are the host-side tally of what the stream carried.
    expect(stoppedEvents(events)).toEqual([{
      event: "sandbox.network.proxy.stopped",
      ts: expect.any(String),
      schemaVersion: SANDBOX_NETWORK_EVENT_SCHEMA_VERSION,
      allowCount: 1,
      denyCount: 2,
      sinkErrorCount: 0,
    }]);
  });

  it.runIf(process.platform === "linux")("contains a throwing network decision sink without changing egress", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-sink-"));
    cleanup.push(workspace);
    const server = http.createServer((_request, response) => response.end("allowed-response"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
    const events: SandboxNetworkEvent[] = [];
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        networkScope: "allowlist",
        networkAllowlist: [`127.0.0.1:${address.port}`],
        onNetworkDecision: (event) => {
          events.push(event);
          throw new Error("network decision sink is intentionally broken");
        },
      },
    });
    const delimiterIndex = target.args.indexOf("--");
    const socketPath = target.args[delimiterIndex + 3];
    const request = (url: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = http.request({ socketPath, path: url, headers: { host: new URL(url).host } }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });

    try {
      // Allow still forwards, deny still denies, and the proxy survives a second request after the throw.
      await expect(request(`http://127.0.0.1:${address.port}/canary`)).resolves.toEqual({
        status: 200,
        body: "allowed-response",
      });
      await expect(request("http://example.com/")).resolves.toMatchObject({ status: 403 });
      await expect(request(`http://127.0.0.1:${address.port}/second`)).resolves.toEqual({
        status: 200,
        body: "allowed-response",
      });
      const connectResponse = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
          socket.end("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
        });
        let response = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => { response += chunk; });
        socket.on("end", () => resolve(response));
        socket.on("error", reject);
      });
      expect(connectResponse).toContain("HTTP/1.1 403 Forbidden\r\n");
      // Every decision still reached the sink and every one of them threw.
      expect(decisionEvents(events)).toHaveLength(4);
    } finally {
      await target.cleanup?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // A sink cannot report its own failure in real time, so the swallowed throws surface at teardown.
    const stopped = stoppedEvents(events);
    expect(stopped).toHaveLength(1);
    expect(stopped[0].sinkErrorCount).toBe(events.length - 1);
    expect(stopped[0].sinkErrorCount).toBeGreaterThan(0);
  });

  it.runIf(process.platform === "linux")("reports a malformed CONNECT target separately from a policy denial", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-malformed-"));
    cleanup.push(workspace);
    const events: SandboxNetworkEvent[] = [];
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        networkScope: "allowlist",
        networkAllowlist: ["api.openai.com"],
        onNetworkDecision: (event) => events.push(event),
      },
    });
    const socketPath = proxySocketPath(target.args);

    try {
      const malformedPort = await connectThroughProxy(socketPath, "example.com:not-a-port");
      const missingPort = await connectThroughProxy(socketPath, "badhost");
      const policyDenial = await connectThroughProxy(socketPath, "denied.example:443");
      // The wire response is unchanged across all three; only the event distinguishes the cause. The
      // confined process must not learn which branch it hit.
      expect(malformedPort).toContain("HTTP/1.1 403 Forbidden\r\n");
      expect(missingPort).toEqual(policyDenial);
      expect(malformedPort).toEqual(policyDenial);
      const decisions = decisionEvents(events);
      expect(decisions.map((event) => event.reason)).toEqual([
        "invalid_connect_target",
        "invalid_connect_target",
        "network_target_denied",
      ]);
      for (const event of decisions) {
        expect(event).toMatchObject({ decision: "deny", method: "CONNECT", scheme: null, tunnelId: null });
      }
      expect(decisions[2]).toMatchObject({ hostname: "denied.example", port: "443" });
    } finally {
      await target.cleanup?.();
    }
  });

  it.runIf(process.platform === "linux")("denies an out-of-range CONNECT port instead of crashing the proxy", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-port-range-"));
    cleanup.push(workspace);
    const events: SandboxNetworkEvent[] = [];
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        // Hostname-only, the common allowlist form: the rule's port is null, so it matches every port
        // and policy cannot be what stops an out-of-range one. The range check has to.
        networkAllowlist: ["allowed.example"],
        onNetworkDecision: (event) => events.push(event),
      },
    });
    const socketPath = proxySocketPath(target.args);

    try {
      const { result, uncaught } = await captureUncaughtExceptions(async () => ({
        // net.connect validates the port synchronously, so an allowed 99999 throws ERR_SOCKET_BAD_PORT
        // out of the connect handler and takes the host adapter process with it.
        aboveRange: await connectThroughProxyWithDeadline(socketPath, "allowed.example:99999"),
        // 65536 is the first illegal port; 0 does not throw but silently retargets, which is a wrong
        // connection rather than a denial. Both have to deny.
        justAboveRange: await connectThroughProxyWithDeadline(socketPath, "allowed.example:65536"),
        zero: await connectThroughProxyWithDeadline(socketPath, "allowed.example:0"),
        // Taken last, from the surviving proxy: the reference denial the three above must match byte
        // for byte, and proof the proxy is still serving after them.
        policyDenial: await connectThroughProxyWithDeadline(socketPath, "denied.example:443"),
      }));

      // 1. The proxy survives the request.
      expect(uncaught).toEqual([]);
      expect(result.policyDenial).toContain("HTTP/1.1 403 Forbidden\r\n");

      // 2. One deny per attempt, reason invalid_connect_target, and no allow anywhere.
      const decisions = decisionEvents(events);
      expect(decisions.map((event) => event.reason)).toEqual([
        "invalid_connect_target",
        "invalid_connect_target",
        "invalid_connect_target",
        "network_target_denied",
      ]);
      for (const event of decisions) {
        expect(event).toMatchObject({ decision: "deny", method: "CONNECT", scheme: null, tunnelId: null });
      }
      expect(decisions.slice(0, 3).map((event) => event.port)).toEqual(["99999", "65536", "0"]);
      // No tunnel was opened, so no tunnel.closed can be correlated to one.
      expect(tunnelEvents(events)).toEqual([]);

      // 3. The wire response is byte-identical to a policy denial: the confined process learns nothing
      // about which branch it hit, so an out-of-range port stays as unreachable as it already was.
      expect(result.aboveRange).toEqual(result.policyDenial);
      expect(result.justAboveRange).toEqual(result.policyDenial);
      expect(result.zero).toEqual(result.policyDenial);
    } finally {
      await target.cleanup?.();
    }
  });

  it.runIf(process.platform === "linux")("records an allow for an allowlisted host that is unreachable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-unreachable-"));
    cleanup.push(workspace);
    // A port nothing is listening on: the policy decision must be recorded even though the upstream
    // TCP connect fails. Emitting from the net.connect callback would drop exactly this case, which is
    // what an attacker enumerating the allowlist produces.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const probeAddress = probe.address();
    if (!probeAddress || typeof probeAddress === "string") throw new Error("Expected TCP probe address.");
    const closedPort = probeAddress.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const events: SandboxNetworkEvent[] = [];
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: [`127.0.0.1:${closedPort}`],
        onNetworkDecision: (event) => events.push(event),
      },
    });
    const socketPath = proxySocketPath(target.args);

    try {
      await connectThroughProxy(socketPath, `127.0.0.1:${closedPort}`).catch(() => "");
      const decisions = decisionEvents(events);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        decision: "allow",
        reason: "allowlist_match",
        hostname: "127.0.0.1",
        port: String(closedPort),
        method: "CONNECT",
      });
      expect(decisions[0].tunnelId).toEqual(expect.any(String));
    } finally {
      await target.cleanup?.();
    }
  });

  it.runIf(process.platform === "linux")("accounts for tunnel bytes and correlates them to the CONNECT decision", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-tunnel-"));
    cleanup.push(workspace);
    const upstream = net.createServer((socket) => {
      socket.on("data", () => socket.end("tunnel-upstream-reply"));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP upstream address.");
    const events: SandboxNetworkEvent[] = [];
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: [`127.0.0.1:${address.port}`],
        onNetworkDecision: (event) => events.push(event),
      },
    });
    const socketPath = proxySocketPath(target.args);

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
          socket.write(`CONNECT 127.0.0.1:${address.port} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`);
        });
        let established = false;
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          if (!established && chunk.includes("200 Connection Established")) {
            established = true;
            socket.write("tunnel-client-payload");
          }
        });
        socket.on("close", () => resolve());
        socket.on("error", reject);
      });
      // The tunnel event fires from the client-socket close seam, which also covers the error path.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const tunnels = tunnelEvents(events);
      expect(tunnels).toHaveLength(1);
      expect(tunnels[0].bytesOut).toBeGreaterThan(0);
      expect(tunnels[0].bytesIn).toBeGreaterThan(0);
      expect(tunnels[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(tunnels[0]).toMatchObject({ hostname: "127.0.0.1", port: String(address.port) });
      // Without the shared tunnelId the byte totals cannot be attributed to a hostname decision.
      expect(tunnels[0].tunnelId).toBe(decisionEvents(events)[0].tunnelId);
      // Payload bytes are counted, never recorded.
      expect(JSON.stringify(tunnels)).not.toMatch(/tunnel-client-payload/);
    } finally {
      await target.cleanup?.();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it.runIf(process.platform === "linux")("stamps a schema version on every event kind and the emitter version on startup", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-schema-"));
    cleanup.push(workspace);
    const upstream = net.createServer((socket) => {
      socket.on("data", () => socket.end("schema-upstream-reply"));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP upstream address.");
    const events: SandboxNetworkEvent[] = [];
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: [`127.0.0.1:${address.port}`],
        onNetworkDecision: (event) => events.push(event),
      },
    });
    const socketPath = proxySocketPath(target.args);

    try {
      // One allowed CONNECT plus one denial: between them the run produces all four event kinds.
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
          socket.write(`CONNECT 127.0.0.1:${address.port} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`);
        });
        let established = false;
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          if (!established && chunk.includes("200 Connection Established")) {
            established = true;
            socket.write("schema-client-payload");
          }
        });
        socket.on("close", () => resolve());
        socket.on("error", reject);
      });
      await connectThroughProxy(socketPath, "denied.example:443");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    } finally {
      await target.cleanup?.();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }

    // All four kinds present, so the assertion below is a statement about the family, not one event.
    expect(new Set(events.map((event) => event.event))).toEqual(new Set([
      "sandbox.network.proxy.started",
      "sandbox.network.decision",
      "sandbox.network.tunnel.closed",
      "sandbox.network.proxy.stopped",
    ]));
    // The sink stamps the envelope, so a future event kind cannot ship without a version on it.
    for (const event of events) {
      expect(event.schemaVersion).toBe(SANDBOX_NETWORK_EVENT_SCHEMA_VERSION);
    }
    // Which build enforced the allowlist, stated rather than inferred from the absence of a complaint.
    expect(startedEvents(events)[0].emitterVersion).toEqual(expect.any(String));
    expect(startedEvents(events)[0].emitterVersion).not.toBe("");
  });

  it.runIf(process.platform === "linux")("bounds and scrubs the event hostname without flagging a valid IPv6 target", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-hostname-"));
    cleanup.push(workspace);
    const events: SandboxNetworkEvent[] = [];
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: ["api.openai.com"],
        onNetworkDecision: (event) => events.push(event),
      },
    });
    const socketPath = proxySocketPath(target.args);

    try {
      await connectThroughProxy(socketPath, `${"a".repeat(4096)}:443`);
      // Underscore is legal in a request target and outside the event charset, so it exercises the
      // scrub without the HTTP parser rejecting the request line before the proxy ever sees it.
      await connectThroughProxy(socketPath, "under_score.example:443");
      await connectThroughProxy(socketPath, "[2001:db8::1]:443");
      const decisions = decisionEvents(events);
      expect(decisions).toHaveLength(3);
      // A 4KB request-line hostname is capped at the longest legal DNS name and flagged.
      expect(Buffer.byteLength(decisions[0].hostname ?? "")).toBe(253);
      expect(decisions[0].hostnameSanitized).toBe(true);
      // Anything outside [a-z0-9.\-:] is replaced, so a run log reader is never handed control bytes.
      expect(decisions[1].hostname).toBe("under?score.example");
      expect(decisions[1].hostnameSanitized).toBe(true);
      // The charset permits ":", or every IPv6 target would be falsely flagged.
      expect(decisions[2]).toMatchObject({ hostname: "2001:db8::1", hostnameSanitized: false });
    } finally {
      await target.cleanup?.();
    }
  });

  it.runIf(process.platform === "linux")("matches an IPv6 allowlist entry against an IPv6 CONNECT target", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-ipv6-"));
    cleanup.push(workspace);
    const events: SandboxNetworkEvent[] = [];
    // WHATWG URL keeps the brackets on the rule side while the target side strips them, so before the
    // fix this entry parsed cleanly and then denied every IPv6 target.
    const [allowlistEntry] = parseLocalProcessNetworkAllowlist(["[::1]:8443"]);
    expect(allowlistEntry).toBe("[::1]:8443");
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: [allowlistEntry],
        onNetworkDecision: (event) => events.push(event),
      },
    });
    const socketPath = proxySocketPath(target.args);

    try {
      await connectThroughProxy(socketPath, "[::1]:8443").catch(() => "");
      const decisions = decisionEvents(events);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        decision: "allow",
        reason: "allowlist_match",
        hostname: "::1",
        port: "8443",
        hostnameSanitized: false,
      });
    } finally {
      await target.cleanup?.();
    }
  });

  it.runIf(process.platform === "linux")("brackets lifecycle events around a run that attempts no egress", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-lifecycle-"));
    cleanup.push(workspace);
    const events: SandboxNetworkEvent[] = [];
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: ["api.openai.com"],
        // One valid trusted URL and one that cannot parse: the dropped entry must stay visible.
        networkTrustedUrls: ["https://control.example/api", "not-a-url"],
        onNetworkDecision: (event) => events.push(event),
      },
    });

    expect(startedEvents(events)).toHaveLength(1);
    expect(startedEvents(events)[0]).toMatchObject({
      allowlistEntryCount: 1,
      trustedUrlCount: 2,
      // One allowlist rule plus one surviving trusted URL: the invalid entry was filtered out.
      ruleCount: 2,
    });
    await target.cleanup?.();
    // Zero egress attempts is now distinguishable from a proxy that never started or a broken sink.
    expect(decisionEvents(events)).toHaveLength(0);
    expect(stoppedEvents(events)).toEqual([{
      event: "sandbox.network.proxy.stopped",
      ts: expect.any(String),
      schemaVersion: SANDBOX_NETWORK_EVENT_SCHEMA_VERSION,
      allowCount: 0,
      denyCount: 0,
      sinkErrorCount: 0,
    }]);
  });

  it("digests the effective ruleset independently of configuration order", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-digest-"));
    cleanup.push(workspace);
    const digestFor = async (allowlist: string[]): Promise<string> => {
      const events: SandboxNetworkEvent[] = [];
      const target = await buildLocalProcessSandboxSpawnTarget({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: workspace,
        options: { workspaceDir: workspace, networkScope: "allowlist", networkAllowlist: allowlist, onNetworkDecision: (event) => events.push(event) },
      }).catch(() => null);
      if (!target) return "";
      await target.cleanup?.();
      return startedEvents(events)[0]?.rulesetDigest ?? "";
    };
    if (process.platform !== "linux") return;
    // Sorting is what makes the digest comparable between two runs holding the same effective rules.
    const first = await digestFor(["api.openai.com", "control.example:8443"]);
    const second = await digestFor(["control.example:8443", "api.openai.com"]);
    const different = await digestFor(["api.openai.com"]);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toBe(first);
    expect(different).not.toBe(first);
  });

  it.runIf(process.platform === "linux")("always permits trusted Paperclip control-plane URLs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-trusted-"));
    cleanup.push(workspace);
    const server = http.createServer((_request, response) => response.end("control-plane-response"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
    const events: SandboxNetworkEvent[] = [];
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: ["api.openai.com"],
        networkTrustedUrls: [`http://127.0.0.1:${address.port}/api/issues/issue-1`],
        onNetworkDecision: (event) => events.push(event),
      },
    });
    const delimiterIndex = target.args.indexOf("--");
    const socketPath = target.args[delimiterIndex + 3];

    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = http.request({
          socketPath,
          path: `http://127.0.0.1:${address.port}/api/issues/issue-1`,
          headers: { host: `127.0.0.1:${address.port}` },
        }, (incoming) => {
          let body = "";
          incoming.on("data", (chunk) => { body += chunk; });
          incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
      expect(response).toEqual({ status: 200, body: "control-plane-response" });
      // A control-plane allow is attributed to the trusted-URL surface, not the operator allowlist.
      const decisions = decisionEvents(events);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        decision: "allow",
        reason: "trusted_url_match",
        hostname: "127.0.0.1",
        port: String(address.port),
      });
      // The trusted URL carries a path; the event must not leak it.
      expect(JSON.stringify(decisions)).not.toMatch(/issue-1/);
    } finally {
      await target.cleanup?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails clearly when Bubblewrap is unavailable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-missing-"));
    cleanup.push(workspace);
    await expect(
      runChildProcess("filesystem-sandbox-missing", process.execPath, ["-e", "process.exit(0)"], {
        cwd: workspace,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          command: path.join(workspace, "missing-bwrap"),
        },
      }),
    ).rejects.toThrow("requires Bubblewrap");
  });

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "prevents reads outside the workspace while allowing workspace writes",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-integration-"));
      cleanup.push(root);
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "canary.txt");
      const allowed = path.join(root, "allowed.txt");
      await fs.mkdir(workspace);
      await fs.writeFile(outside, "host-secret", "utf8");
      await fs.writeFile(allowed, "allowed-value", "utf8");

      const script = [
        "const fs = require('node:fs');",
        `try { fs.readFileSync(${JSON.stringify(outside)}, 'utf8'); process.exit(9); } catch (error) {`,
        "  if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;",
        "}",
        `if (fs.readFileSync(${JSON.stringify(allowed)}, 'utf8') !== 'allowed-value') process.exit(8);`,
        "fs.writeFileSync('workspace-ok.txt', 'ok');",
      ].join("\n");
      const result = await runChildProcess("filesystem-sandbox-test", process.execPath, ["-e", script], {
        cwd: workspace,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          extraPaths: [{ path: allowed, access: "ro" }],
          command: process.env.PAPERCLIP_TEST_BWRAP,
        },
      });

      expect(result.exitCode, result.stderr).toBe(0);
      await expect(fs.readFile(path.join(workspace, "workspace-ok.txt"), "utf8")).resolves.toBe("ok");
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP && process.env.PAPERCLIP_TEST_SANDBOX_BUILD))(
    "runs the adapter-utils TypeScript build inside the confined workspace",
    async () => {
      const workspace = process.cwd();
      const result = await runChildProcess(
        "filesystem-sandbox-build-test",
        path.join(workspace, "node_modules", ".bin", "tsc"),
        ["--noEmit", "-p", "packages/adapter-utils/tsconfig.json"],
        {
          cwd: workspace,
          env: {},
          timeoutSec: 60,
          graceSec: 2,
          onLog: async () => {},
          localProcessSandbox: {
            workspaceDir: workspace,
            filesystemScope: "workspace",
            command: process.env.PAPERCLIP_TEST_BWRAP,
          },
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "denies direct network egress",
    async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-deny-"));
      cleanup.push(workspace);
      const server = http.createServer((_request, response) => response.end("host-network"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
      const script = `require("node:http").get("http://127.0.0.1:${address.port}", () => process.exit(9)).on("error", () => process.exit(0));`;
      try {
        const result = await runChildProcess("network-sandbox-deny-test", process.execPath, ["-e", script], {
          cwd: workspace,
          env: {},
          timeoutSec: 10,
          graceSec: 1,
          onLog: async () => {},
          localProcessSandbox: {
            workspaceDir: workspace,
            networkScope: "deny",
            command: process.env.PAPERCLIP_TEST_BWRAP,
          },
        });
        expect(result.exitCode, result.stderr).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "allows only configured network targets through the proxy bridge",
    async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-allowlist-"));
      cleanup.push(workspace);
      const server = http.createServer((_request, response) => response.end("allowed-response"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
      const targetUrl = `http://127.0.0.1:${address.port}/canary`;
      const deniedUrl = "http://example.com/";
      const script = `
const http = require("node:http");
const proxy = new URL(process.env.HTTP_PROXY);
function request(url) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: proxy.hostname, port: proxy.port, path: url }, (response) => {
      let body = "";
      response.on("data", (chunk) => body += chunk);
      response.on("end", () => resolve({ status: response.statusCode, body }));
    }).on("error", reject);
  });
}
(async () => {
  const allowed = await request(${JSON.stringify(targetUrl)});
  const denied = await request(${JSON.stringify(deniedUrl)});
  if (allowed.status !== 200 || allowed.body !== "allowed-response" || denied.status !== 403) process.exit(8);
})().catch((error) => { console.error(error); process.exit(7); });
`;
      try {
        const deepTmpDir = path.join(workspace, ...Array.from({ length: 6 }, () => "deep-temporary-directory-segment"));
        await fs.mkdir(deepTmpDir, { recursive: true });
        const result = await withTmpDir(deepTmpDir, () =>
          runChildProcess(
            "network-sandbox-allowlist-test",
            process.execPath,
            ["-e", script],
            {
              cwd: workspace,
              env: {},
              timeoutSec: 10,
              graceSec: 1,
              onLog: async () => {},
              localProcessSandbox: {
                workspaceDir: workspace,
                filesystemScope: "workspace",
                networkScope: "allowlist",
                networkAllowlist: [`127.0.0.1:${address.port}`],
                command: process.env.PAPERCLIP_TEST_BWRAP,
              },
            },
          ),
        );
        expect(result.exitCode, result.stderr).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
