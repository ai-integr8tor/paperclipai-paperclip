import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type LocalProcessSandboxAccess = "ro" | "rw";
export type LocalProcessNetworkScope = "deny" | "allowlist";

export interface LocalProcessSandboxPath {
  path: string;
  access: LocalProcessSandboxAccess;
}

export interface LocalProcessSandboxPathAlias {
  path: string;
  target: string;
}

export type SandboxNetworkDecisionOutcome = "allow" | "deny";

export type SandboxNetworkDecisionReason =
  | "allowlist_match"
  | "trusted_url_match"
  | "network_target_denied"
  | "invalid_request_url"
  | "invalid_connect_target"
  | "https_requires_connect";

/**
 * One allow/deny decision made by the sandbox egress proxy.
 *
 * Deliberately carries only the inputs to the decision. The request path, query string, headers and
 * body are attacker-influenced and never included, so a reviewer can trust every field here.
 */
export interface SandboxNetworkDecision {
  event: "sandbox.network.decision";
  /** Host clock at the moment of the decision, ISO 8601 UTC. */
  ts: string;
  decision: SandboxNetworkDecisionOutcome;
  reason: SandboxNetworkDecisionReason;
  /**
   * Hostname normalized by the same helper the policy check uses, so the event and the decision
   * cannot disagree. Null only when the request URL could not be parsed at all.
   *
   * Byte-equal to the string the policy check compared whenever `hostnameSanitized` is false. When
   * that flag is true this is a bounded, charset-scrubbed rendering of that input instead.
   */
  hostname: string | null;
  port: string | null;
  /** Literal "CONNECT" on the tunnel path; the client's method on the plain HTTP path. */
  method: string | null;
  /** Null on the CONNECT path: the proxy does not terminate TLS and must not infer a scheme. */
  scheme: string | null;
  /** True when `hostname` was truncated or charset-scrubbed, so a reader never trusts a mangled name. */
  hostnameSanitized: boolean;
  /** Correlates a CONNECT decision with its `sandbox.network.tunnel.closed` event. Null off that path. */
  tunnelId: string | null;
}

/**
 * Emitted once the proxy is listening. Without it, an empty decision stream cannot distinguish "no
 * egress attempted" from "proxy never started" from "sink broken".
 */
export interface SandboxNetworkProxyStarted {
  event: "sandbox.network.proxy.started";
  ts: string;
  /** Configured `networkAllowlist` entries — the input count. */
  allowlistEntryCount: number;
  /** Configured `networkTrustedUrls` entries — the input count. */
  trustedUrlCount: number;
  /** Rules that survived parsing. Below the input total means a trusted URL was silently dropped. */
  ruleCount: number;
  /** SHA-256 over the sorted `hostname:port` rule tuples, 16 hex chars, comparable across runs. */
  rulesetDigest: string;
}

/**
 * Emitted on the graceful teardown path only. A hard death of the host process yields no stopped
 * event, which is the intended reading: a `started` with no `stopped` is abnormal termination.
 */
export interface SandboxNetworkProxyStopped {
  event: "sandbox.network.proxy.stopped";
  ts: string;
  allowCount: number;
  denyCount: number;
  /**
   * Sink invocations that threw and were swallowed. Reported here because the sink is the transport:
   * a failing sink cannot report its own failure in real time.
   */
  sinkErrorCount: number;
}

/**
 * Byte accounting for one closed CONNECT tunnel. Forensic, not real-time: it fires at tunnel close
 * and is the only signal covering exfiltration to an already-allowlisted host.
 */
export interface SandboxNetworkTunnelClosed {
  event: "sandbox.network.tunnel.closed";
  ts: string;
  tunnelId: string;
  hostname: string | null;
  port: string | null;
  /** Bytes the confined process sent upstream. */
  bytesOut: number;
  /** Bytes the upstream returned. */
  bytesIn: number;
  durationMs: number;
}

/** Every event the proxy can emit, all carried on the one observer — no second seam. */
export type SandboxNetworkEvent =
  | SandboxNetworkDecision
  | SandboxNetworkProxyStarted
  | SandboxNetworkProxyStopped
  | SandboxNetworkTunnelClosed;

export interface LocalProcessSandboxOptions {
  workspaceDir: string;
  filesystemScope?: "workspace" | null;
  managedPaths?: LocalProcessSandboxPath[];
  extraPaths?: LocalProcessSandboxPath[];
  pathAliases?: LocalProcessSandboxPathAlias[];
  outboundRestorePaths?: string[];
  homeDir?: string | null;
  networkScope?: LocalProcessNetworkScope | null;
  networkAllowlist?: string[];
  networkTrustedUrls?: string[];
  /**
   * Observer for every egress decision and for proxy/tunnel lifecycle. Runs in the host process,
   * never inside the sandbox. Throwing from it is contained: it cannot change a policy outcome or
   * stop the proxy.
   */
  onNetworkDecision?: (event: SandboxNetworkEvent) => void;
  command?: string;
}

export interface LocalProcessSandboxSpawnTarget {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  cleanup?: () => Promise<void>;
}

interface NetworkAllowlistRule {
  hostname: string;
  port: string | null;
  /** Which configuration surface contributed the rule, so a match can say why it matched. */
  source: "allowlist" | "trusted_url";
}

interface NetworkAllowlistProxy {
  close: () => Promise<void>;
}

const SYSTEM_READ_PATHS = [
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/etc/ca-certificates",
  "/etc/ssl",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/gitconfig",
] as const;

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
const SANDBOX_PROXY_PORT = 31_337;
const UNIX_SOCKET_PATH_MAX_BYTES = 107;
const NETWORK_PROXY_TEMP_PREFIX = "paperclip-network-sandbox-";

function normalizeAbsolutePath(candidate: string, label: string): string {
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(trimmed);
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.lstat(candidate).then(() => true).catch(() => false);
}

function parentDirectories(candidate: string): string[] {
  const directories: string[] = [];
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    directories.push(current);
    current = path.dirname(current);
  }
  return directories.reverse();
}

function addParentDirectories(args: string[], created: Set<string>, candidate: string): void {
  for (const directory of parentDirectories(candidate)) {
    if (created.has(directory)) continue;
    args.push("--dir", directory);
    created.add(directory);
  }
}

async function nearestPackageRoot(candidate: string): Promise<string> {
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    if (await pathExists(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return path.dirname(candidate);
}

async function executableReadPaths(command: string): Promise<string[]> {
  const paths = new Set<string>();
  paths.add(path.dirname(command));
  const realCommand = await fs.realpath(command).catch(() => command);
  paths.add(await nearestPackageRoot(realCommand));
  return Array.from(paths);
}

function parseNetworkAllowlistEntry(entry: string, index: number): NetworkAllowlistRule {
  const trimmed = entry.trim();
  if (!trimmed) throw new Error(`networkAllowlist[${index}] must not be empty.`);
  let hostname: string;
  let port: string | null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("path");
    }
    // WHATWG URL retains brackets on an IPv6 literal while the target side strips them, so an
    // unnormalized rule could never match and quietly denied every IPv6 target.
    hostname = normalizeNetworkHostname(parsed.hostname);
    port = parsed.port || null;
  } catch {
    throw new Error(`networkAllowlist[${index}] must be a hostname, hostname:port, or origin URL.`);
  }
  if (!hostname || hostname === "*" || hostname.startsWith("*.")) {
    throw new Error(`networkAllowlist[${index}] must use an exact hostname; wildcards are not supported.`);
  }
  return { hostname, port, source: "allowlist" };
}

export function parseLocalProcessNetworkAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`networkAllowlist[${index}] must be a string.`);
    const rule = parseNetworkAllowlistEntry(entry, index);
    return formatNetworkRuleTarget(rule);
  });
}

export function parseLocalProcessNetworkScope(value: unknown): LocalProcessNetworkScope | null {
  if (value == null || value === "") return null;
  if (value === "deny" || value === "allowlist") return value;
  throw new Error('networkScope must be "deny" or "allowlist".');
}

export function parseLocalProcessFilesystemScope(value: unknown): "workspace" | null {
  if (value == null || value === "") return null;
  if (value === "workspace") return value;
  throw new Error('filesystemScope must be "workspace".');
}

/**
 * Single source of truth for hostname normalization. The policy check and the decision event both
 * call this, so an emitted hostname is always the exact value the allowlist was compared against.
 */
function normalizeNetworkHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

/**
 * Renders a rule back into allowlist syntax. IPv6 needs its brackets restored: rules are normalized
 * without them, and `hostname:port` is unparseable for an address that already contains colons.
 */
function formatNetworkRuleTarget(rule: NetworkAllowlistRule): string {
  const hostname = rule.hostname.includes(":") ? `[${rule.hostname}]` : rule.hostname;
  return rule.port ? `${hostname}:${rule.port}` : hostname;
}

/** Longest legal DNS name. A CONNECT target is arbitrary request-line bytes and gets capped here. */
const EVENT_HOSTNAME_MAX_BYTES = 253;
/** `:` is permitted so a valid IPv6 literal is not scrubbed; `%` is not, as downstream readers decode it. */
const EVENT_HOSTNAME_DISALLOWED = /[^a-z0-9.\-:]/g;

interface EventHostname {
  hostname: string | null;
  hostnameSanitized: boolean;
}

/**
 * Bounds and scrubs a hostname for the event record. Fixed order — normalize, truncate, scrub — so
 * the result is deterministic, and the flag makes any mutation visible rather than silent.
 */
function describeEventHostname(rawHostname: string | null): EventHostname {
  if (!rawHostname) return { hostname: null, hostnameSanitized: false };
  const normalized = normalizeNetworkHostname(rawHostname);
  let value = normalized;
  let hostnameSanitized = false;
  if (Buffer.byteLength(value) > EVENT_HOSTNAME_MAX_BYTES) {
    value = Buffer.from(value).subarray(0, EVENT_HOSTNAME_MAX_BYTES).toString("utf8");
    hostnameSanitized = true;
  }
  const scrubbed = value.replace(EVENT_HOSTNAME_DISALLOWED, "?");
  if (scrubbed !== value) hostnameSanitized = true;
  return { hostname: scrubbed, hostnameSanitized };
}

/** Sorted, or the digest is not comparable between two runs holding the same effective ruleset. */
function computeRulesetDigest(rules: NetworkAllowlistRule[]): string {
  const tuples = rules.map((rule) => `${rule.hostname}:${rule.port ?? "*"}`).sort();
  return createHash("sha256").update(JSON.stringify(tuples)).digest("hex").slice(0, 16);
}

/** Returns the rule that permitted the target, or null when policy denies it. */
function matchNetworkTarget(
  hostname: string,
  port: string,
  rules: NetworkAllowlistRule[],
): NetworkAllowlistRule | null {
  const normalizedHostname = normalizeNetworkHostname(hostname);
  return rules.find((rule) => rule.hostname === normalizedHostname && (rule.port === null || rule.port === port)) ?? null;
}

function isNetworkTargetAllowed(hostname: string, port: string, rules: NetworkAllowlistRule[]): boolean {
  return matchNetworkTarget(hostname, port, rules) !== null;
}

function assertUnixSocketPathLength(socketPath: string): void {
  const pathBytes = Buffer.byteLength(socketPath);
  if (pathBytes > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `Paperclip sandbox proxy socket path is ${pathBytes} bytes, exceeding the Linux limit of ${UNIX_SOCKET_PATH_MAX_BYTES}: ${socketPath}`,
    );
  }
}

async function createNetworkProxyTempDir(): Promise<string> {
  const candidates = Array.from(new Set(["/tmp", os.tmpdir()]));
  let lastError: unknown;
  for (const baseDir of candidates) {
    try {
      const tempDir = await fs.mkdtemp(path.join(baseDir, NETWORK_PROXY_TEMP_PREFIX));
      try {
        assertUnixSocketPathLength(path.join(tempDir, "proxy.sock"));
        return tempDir;
      } catch (error) {
        await fs.rm(tempDir, { recursive: true, force: true });
        lastError = error;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Unable to create a Linux-safe Paperclip sandbox proxy socket directory.", { cause: lastError });
}

function parseTrustedNetworkUrl(value: string): NetworkAllowlistRule | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return {
      hostname: normalizeNetworkHostname(parsed.hostname),
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
      source: "trusted_url",
    };
  } catch {
    return null;
  }
}

type SandboxNetworkEventInput = SandboxNetworkEvent extends infer Event
  ? Event extends SandboxNetworkEvent ? Omit<Event, "ts"> : never
  : never;

interface SandboxNetworkEventSink {
  emit: (event: SandboxNetworkEventInput) => void;
  counters: () => { allowCount: number; denyCount: number; sinkErrorCount: number };
}

/**
 * Hands events to the observer without letting it affect egress. A sink that throws is an
 * observability bug; it must never become a policy bug or take the proxy down. Swallowed throws are
 * counted instead and reported once at teardown, because the sink is the only transport available.
 */
function createNetworkEventSink(
  onNetworkDecision: ((event: SandboxNetworkEvent) => void) | undefined,
): SandboxNetworkEventSink {
  let allowCount = 0;
  let denyCount = 0;
  let sinkErrorCount = 0;
  return {
    emit: (event) => {
      if (event.event === "sandbox.network.decision") {
        if (event.decision === "allow") allowCount += 1;
        else denyCount += 1;
      }
      if (!onNetworkDecision) return;
      try {
        onNetworkDecision({ ts: new Date().toISOString(), ...event } as SandboxNetworkEvent);
      } catch {
        // Intentionally swallowed: see the doc comment above.
        sinkErrorCount += 1;
      }
    },
    counters: () => ({ allowCount, denyCount, sinkErrorCount }),
  };
}

function writeProxyError(response: http.ServerResponse, status: number, code: string, message: string): void {
  const body = `${JSON.stringify({ error: { code, message } })}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  }).end(body);
}

function connectProxyError(code: string, message: string): string {
  const body = `${JSON.stringify({ error: { code, message } })}\n`;
  return [
    "HTTP/1.1 403 Forbidden",
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

async function startNetworkAllowlistProxy(
  allowlist: string[],
  trustedUrls: string[],
  socketPath: string,
  onNetworkDecision?: (event: SandboxNetworkEvent) => void,
): Promise<NetworkAllowlistProxy> {
  assertUnixSocketPathLength(socketPath);
  const sink = createNetworkEventSink(onNetworkDecision);
  const rules = [
    ...allowlist.map(parseNetworkAllowlistEntry),
    ...trustedUrls.map(parseTrustedNetworkUrl).filter((rule): rule is NetworkAllowlistRule => rule !== null),
  ];
  if (rules.length === 0) {
    throw new Error(
      'networkScope="allowlist" requires at least one valid networkAllowlist hostname or HTTP(S) networkTrustedUrl.',
    );
  }
  const server = http.createServer((request, response) => {
    const method = request.method ?? null;
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      sink.emit({
        event: "sandbox.network.decision",
        decision: "deny",
        reason: "invalid_request_url",
        hostname: null,
        port: null,
        method,
        scheme: null,
        hostnameSanitized: false,
        tunnelId: null,
      });
      writeProxyError(response, 400, "invalid_request_url", "Paperclip sandbox proxy requires an absolute request URL.");
      return;
    }
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    const { hostname, hostnameSanitized } = describeEventHostname(target.hostname);
    const scheme = target.protocol.replace(/:$/, "");
    if (target.protocol !== "http:") {
      sink.emit({
        event: "sandbox.network.decision",
        decision: "deny",
        reason: "https_requires_connect",
        hostname,
        port,
        method,
        scheme,
        hostnameSanitized,
        tunnelId: null,
      });
      writeProxyError(response, 400, "https_requires_connect", "HTTPS targets must use CONNECT through the Paperclip sandbox proxy.");
      return;
    }
    const matchedRule = matchNetworkTarget(target.hostname, port, rules);
    if (!matchedRule) {
      sink.emit({
        event: "sandbox.network.decision",
        decision: "deny",
        reason: "network_target_denied",
        hostname,
        port,
        method,
        scheme,
        hostnameSanitized,
        tunnelId: null,
      });
      writeProxyError(response, 403, "network_target_denied", "Network target denied by Paperclip sandbox policy.");
      return;
    }
    sink.emit({
      event: "sandbox.network.decision",
      decision: "allow",
      reason: matchedRule.source === "trusted_url" ? "trusted_url_match" : "allowlist_match",
      hostname,
      port,
      method,
      scheme,
      hostnameSanitized,
      tunnelId: null,
    });
    const upstream = http.request(target, {
      method: request.method,
      headers: { ...request.headers, host: target.host },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => response.destroy(error));
    request.pipe(upstream);
  });
  server.on("connect", (request, clientSocket, head) => {
    const separator = request.url?.lastIndexOf(":") ?? -1;
    const hostname = separator > 0 ? normalizeNetworkHostname(request.url!.slice(0, separator)) : "";
    const port = separator > 0 ? request.url!.slice(separator + 1) : "443";
    // The proxy tunnels CONNECT opaquely, so the method is always the literal verb and the scheme is
    // unknowable. Neither is ever inferred.
    const connectEvent = {
      event: "sandbox.network.decision",
      method: "CONNECT",
      scheme: null,
      ...describeEventHostname(hostname),
      port: port || null,
    } as const;
    const malformedTarget = !hostname || !/^\d+$/.test(port);
    const matchedRule = malformedTarget ? null : matchNetworkTarget(hostname, port, rules);
    if (malformedTarget || !matchedRule) {
      sink.emit({
        ...connectEvent,
        decision: "deny",
        // A malformed CONNECT line and a real policy miss are different signals for alerting, even
        // though the wire response stays identical so egress behaviour does not change.
        reason: malformedTarget ? "invalid_connect_target" : "network_target_denied",
        tunnelId: null,
      });
      clientSocket.end(connectProxyError(
        "network_target_denied",
        "Network target denied by Paperclip sandbox policy.",
      ));
      return;
    }
    // Emitted at the decision point, not in the net.connect callback: this records the policy
    // outcome, which is independent of whether the upstream TCP connection later succeeds.
    const tunnelId = randomUUID();
    sink.emit({
      ...connectEvent,
      decision: "allow",
      reason: matchedRule.source === "trusted_url" ? "trusted_url_match" : "allowlist_match",
      tunnelId,
    });
    const tunnelOpenedAt = Date.now();
    const upstream = net.connect(Number(port), hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("close", () => {
      // Counters come off the socket rather than a transform in the pipe path: Node maintains both
      // natively, so byte accounting costs nothing on the path carrying all confined egress. This
      // seam also covers the failure path, since an upstream error destroys the client socket.
      const bytesOut = upstream.bytesWritten;
      const bytesIn = upstream.bytesRead;
      upstream.destroy();
      sink.emit({
        event: "sandbox.network.tunnel.closed",
        tunnelId,
        hostname: connectEvent.hostname,
        port: connectEvent.port,
        bytesOut,
        bytesIn,
        durationMs: Date.now() - tunnelOpenedAt,
      });
    });
  });
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      // Both count sides are reported deliberately: invalid trusted URLs are filtered out silently
      // above, so trustedUrlCount above the trusted rules inside ruleCount is a misconfigured
      // profile this event makes visible.
      sink.emit({
        event: "sandbox.network.proxy.started",
        allowlistEntryCount: allowlist.length,
        trustedUrlCount: trustedUrls.length,
        ruleCount: rules.length,
        rulesetDigest: computeRulesetDigest(rules),
      });
      resolve();
    });
  });
  let stopEventEmitted = false;
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (stopEventEmitted) return;
      stopEventEmitted = true;
      // Best effort by design: this is the graceful path only, so a hard death of the host process
      // yields a started event with no stopped event — which reads as abnormal termination.
      sink.emit({ event: "sandbox.network.proxy.stopped", ...sink.counters() });
    },
  };
}

async function createNetworkProxyBridge(): Promise<string> {
  const source = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const socketPath = process.argv[2];
const executable = process.argv[3];
const args = process.argv.slice(4);
const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close);
  upstream.on("error", close);
});
server.listen(${SANDBOX_PROXY_PORT}, "127.0.0.1", () => {
  const child = spawn(executable, args, { stdio: "inherit", env: process.env });
  const forward = (signal) => { if (!child.killed) child.kill(signal); };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.on("exit", (code, signal) => server.close(() => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 1 : code);
  }));
});
`;
  return source.trimStart();
}

export async function buildLocalProcessSandboxSpawnTarget(input: {
  executable: string;
  args: string[];
  cwd: string;
  options: LocalProcessSandboxOptions;
}): Promise<LocalProcessSandboxSpawnTarget> {
  if (process.platform !== "linux") {
    throw new Error("Local process filesystem and network scopes are currently supported only on Linux.");
  }
  const filesystemScope = input.options.filesystemScope ?? null;
  const networkScope = input.options.networkScope ?? null;
  if (!filesystemScope && !networkScope) throw new Error("Local process sandbox requires a filesystem or network scope.");

  const workspaceDir = normalizeAbsolutePath(input.options.workspaceDir, "Sandbox workspaceDir");
  const cwd = normalizeAbsolutePath(input.cwd, "Sandbox cwd");
  if (filesystemScope === "workspace") {
    const relativeCwd = path.relative(workspaceDir, cwd);
    if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
      throw new Error(`Sandbox cwd "${cwd}" must be inside workspaceDir "${workspaceDir}".`);
    }
    const outboundRestorePaths = (input.options.outboundRestorePaths ?? []).map((candidate, index) =>
      normalizeAbsolutePath(candidate, `Sandbox outboundRestorePaths[${index}]`));
    for (const [index, extraPath] of (input.options.extraPaths ?? []).entries()) {
      if (extraPath.access !== "rw") continue;
      const normalizedExtraPath = normalizeAbsolutePath(extraPath.path, `Sandbox extraPaths[${index}].path`);
      const relativeToWorkspace = path.relative(workspaceDir, normalizedExtraPath);
      const synchronized = !relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace);
      const restored = outboundRestorePaths.some((restorePath) => {
        const relative = path.relative(restorePath, normalizedExtraPath);
        return !relative.startsWith("..") && !path.isAbsolute(relative);
      });
      if (!synchronized && !restored) {
        throw new Error(
          `Writable sandbox path "${normalizedExtraPath}" is outside synchronized workspace "${workspaceDir}" and has no outbound restore mapping.`,
        );
      }
    }
  }

  const bwrapCommand = input.options.command?.trim() || "bwrap";
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  const env: Record<string, string | undefined> = {};
  let cleanup: (() => Promise<void>) | undefined;
  let executable = input.executable;
  let executableArgs = input.args;

  if (filesystemScope === "workspace") {
    args.push("--tmpfs", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
    args.push(
      "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/sbin", "/sbin",
      "--symlink", "usr/lib", "/lib",
      "--symlink", "usr/lib64", "/lib64",
    );
    const created = new Set<string>(["/", "/proc", "/dev", "/tmp"]);
    const mounted = new Set<string>();
    const mount = async (source: string, access: LocalProcessSandboxAccess) => {
      const normalized = normalizeAbsolutePath(source, "Sandbox path");
      if (mounted.has(normalized) || !(await pathExists(normalized))) return;
      addParentDirectories(args, created, normalized);
      args.push(access === "rw" ? "--bind" : "--ro-bind", normalized, normalized);
      mounted.add(normalized);
      created.add(normalized);
    };
    for (const systemPath of SYSTEM_READ_PATHS) await mount(systemPath, "ro");
    for (const executablePath of await executableReadPaths(input.executable)) await mount(executablePath, "ro");
    if (networkScope === "allowlist") {
      for (const nodePath of await executableReadPaths(process.execPath)) await mount(nodePath, "ro");
    }
    for (const managedPath of input.options.managedPaths ?? []) await mount(managedPath.path, managedPath.access);
    for (const extraPath of input.options.extraPaths ?? []) await mount(extraPath.path, extraPath.access);
    await mount(workspaceDir, "rw");
    for (const [index, alias] of (input.options.pathAliases ?? []).entries()) {
      const aliasPath = normalizeAbsolutePath(alias.path, `Sandbox pathAliases[${index}].path`);
      const aliasTarget = normalizeAbsolutePath(alias.target, `Sandbox pathAliases[${index}].target`);
      const relativeTarget = path.relative(workspaceDir, aliasTarget);
      if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
        throw new Error(
          `Sandbox path alias "${aliasPath}" must target the synchronized workspace "${workspaceDir}".`,
        );
      }
      if (!(await pathExists(aliasTarget))) {
        throw new Error(`Sandbox path alias target "${aliasTarget}" does not exist.`);
      }
      addParentDirectories(args, created, aliasPath);
      args.push("--bind", aliasTarget, aliasPath);
      created.add(aliasPath);
    }

    if (networkScope === "allowlist") {
      const tempDir = await createNetworkProxyTempDir();
      const socketPath = path.join(tempDir, "proxy.sock");
      const bridgePath = path.join(tempDir, "bridge.cjs");
      await fs.writeFile(bridgePath, await createNetworkProxyBridge(), { mode: 0o500 });
      const proxy = await startNetworkAllowlistProxy(
        input.options.networkAllowlist ?? [],
        input.options.networkTrustedUrls ?? [],
        socketPath,
        input.options.onNetworkDecision,
      ).catch(async (error) => {
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
      });
      await mount(tempDir, "rw");
      executable = process.execPath;
      executableArgs = [bridgePath, socketPath, input.executable, ...input.args];
      cleanup = async () => {
        await proxy.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      };
    }
  } else {
    args.push("--bind", "/", "/");
    if (networkScope === "allowlist") {
      const tempDir = await createNetworkProxyTempDir();
      const socketPath = path.join(tempDir, "proxy.sock");
      const bridgePath = path.join(tempDir, "bridge.cjs");
      await fs.writeFile(bridgePath, await createNetworkProxyBridge(), { mode: 0o500 });
      const proxy = await startNetworkAllowlistProxy(
        input.options.networkAllowlist ?? [],
        input.options.networkTrustedUrls ?? [],
        socketPath,
        input.options.onNetworkDecision,
      ).catch(async (error) => {
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
      });
      executable = process.execPath;
      executableArgs = [bridgePath, socketPath, input.executable, ...input.args];
      cleanup = async () => {
        await proxy.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      };
    }
  }

  if (networkScope) {
    args.push("--unshare-net");
    for (const key of PROXY_ENV_KEYS) env[key] = undefined;
    env.NO_PROXY = "";
    env.no_proxy = "";
  }
  if (networkScope === "allowlist") {
    const proxyUrl = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
  }

  args.push("--chdir", cwd, "--", executable, ...executableArgs);
  return { command: bwrapCommand, args, cwd: "/", env, cleanup };
}

export function parseLocalProcessSandboxExtraPaths(value: unknown): LocalProcessSandboxPath[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      return { path: normalizeAbsolutePath(entry, `filesystemExtraPaths[${index}]`), access: "ro" };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`filesystemExtraPaths[${index}] must be an absolute path or { path, access } object.`);
    }
    const raw = entry as Record<string, unknown>;
    const access = raw.access === "rw" ? "rw" : raw.access === "ro" || raw.access == null ? "ro" : null;
    if (!access || typeof raw.path !== "string") {
      throw new Error(`filesystemExtraPaths[${index}] must use access "ro" or "rw" and an absolute path.`);
    }
    return { path: normalizeAbsolutePath(raw.path, `filesystemExtraPaths[${index}].path`), access };
  });
}
