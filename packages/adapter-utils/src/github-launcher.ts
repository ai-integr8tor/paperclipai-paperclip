/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(): string {
  return String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
const executable = originalPath.map(p => path.join(p, program)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
});
if (!['git', 'gh'].includes(program) || !executable) {
  process.stderr.write('Paperclip: requested GitHub command is not installed.\n');
  process.exit(127);
}
async function main() {
  let env = { ...process.env };
  const diagnostic = (code) => process.stderr.write('Paperclip: GitHub ' + code + '; continuing without managed credentials.\n');
  // A missing/unwritable scratch directory must not break local Git. The
  // fallback deliberately cannot load the host's gh authentication files.
  // Agent sandboxes (e.g. Claude Code Seatbelt) may deny writes to the staged
  // GH_CONFIG_DIR, so fall back to the sandbox-provided temp directory.
  let configDirectory = path.join(directory, 'unavailable-gh-config');
  let configReady = false;
  for (const configRoot of [...new Set([env.GH_CONFIG_DIR, os.tmpdir()].filter(Boolean))]) {
    try {
      fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
      configDirectory = fs.mkdtempSync(path.join(configRoot, 'paperclip-github-operation-'));
      fs.chmodSync(configDirectory, 0o700);
      configReady = true;
      const created = configDirectory;
      process.once('exit', () => { try { fs.rmSync(created, { recursive: true, force: true }); } catch {} });
      break;
    } catch {}
  }
  if (!configReady) diagnostic('configuration_directory_unavailable');
  {
    for (const key of Object.keys(env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      GH_CONFIG_DIR: configDirectory, SSH_AUTH_SOCK: '',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      // The inherited identity was deleted above. Empty identity env values
      // override even explicit repository/command config and break local commits.
      // Require configured identity instead of guessing the OS user's details.
      GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'core.askPass', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'user.useConfigOnly', GIT_CONFIG_VALUE_4: 'true',
    });
    const base = env.PAPERCLIP_GITHUB_BROKER_URL || env.PAPERCLIP_API_URL;
    try {
    let response;
    if (base && env.PAPERCLIP_GITHUB_BROKER_TOKEN) {
      const url = base.replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/credentials';
      const headers = { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
        'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' };
      // Node fetch ignores HTTP_PROXY. Agent sandboxes (Claude Code Seatbelt) deny
      // direct sockets, loopback included, with EPERM and leave a loopback proxy as
      // the only way out. The broker bearer and capability must not reach a proxy
      // the agent picked, so the fallback is deliberately narrow:
      // - the proxy must be http:// on a loopback literal with an explicit port.
      //   Inside the sandbox the agent cannot bind loopback, so that is the
      //   sandbox's own proxy; remote proxies are never used;
      // - requests always go through a CONNECT tunnel. HTTPS brokers get
      //   end-to-end TLS verified against the broker host, so the proxy sees only
      //   ciphertext; the sandbox also denies DNS, so any direct failure retries.
      // - plain-HTTP brokers must be loopback IPs and retry only after a sandbox
      //   socket denial (EPERM/EACCES); a refused or timed-out broker never
      //   consults HTTP_PROXY. The proxy allowlist still decides egress.
      const target = new URL(url);
      const secure = target.protocol === 'https:';
      const proxy = (() => {
        try { return new URL(secure ? (env.HTTPS_PROXY || env.https_proxy || '') : (env.HTTP_PROXY || env.http_proxy || '')); } catch { return null; }
      })();
      const trustedProxy = proxy && proxy.protocol === 'http:' && proxy.port && ['localhost', '127.0.0.1', '[::1]'].includes(proxy.hostname) ? proxy : null;
      const tunnelable = secure || (target.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(target.hostname));
      const retryable = (error) => secure || ['EPERM', 'EACCES'].includes(error && error.cause && error.cause.code);
      let viaProxy = false;
      const tunnelPost = () => new Promise((resolve, reject) => {
        const http = require('node:http');
        const port = target.port || (secure ? '443' : '80');
        const authority = target.hostname + ':' + port;
        const connectHeaders = { host: authority };
        if (trustedProxy.username) connectHeaders['proxy-authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(trustedProxy.username) + ':' + decodeURIComponent(trustedProxy.password)).toString('base64');
        const connect = http.request({ host: trustedProxy.hostname.replace(/^\[|\]$/g, ''), port: trustedProxy.port, method: 'CONNECT', path: authority, headers: connectHeaders, timeout: 10000, agent: false });
        connect.on('timeout', () => connect.destroy(new Error('timeout')));
        connect.on('error', reject);
        connect.on('connect', (res, socket) => {
          if (res.statusCode !== 200) { socket.destroy(); reject(new Error('proxy refused tunnel')); return; }
          const host = target.hostname.replace(/^\[|\]$/g, '');
          const stream = secure
            ? require('node:tls').connect({ socket, host, rejectUnauthorized: true, servername: require('node:net').isIP(host) ? undefined : host })
            : socket;
          const request = http.request({
            createConnection: () => stream, method: 'POST', path: target.pathname + target.search, timeout: 10000,
            headers: { ...headers, host: target.host, 'content-length': '2', connection: 'close' },
          }, (response) => {
            const chunks = [];
            response.on('data', (c) => chunks.push(c));
            response.on('end', () => {
              stream.destroy();
              const text = Buffer.concat(chunks).toString('utf8');
              const status = response.statusCode || 0;
              resolve({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(text), arrayBuffer: async () => {} });
            });
            response.on('error', reject);
          });
          request.on('timeout', () => request.destroy(new Error('timeout')));
          request.on('error', reject);
          request.end('{}');
        });
        connect.end();
      });
      const post = async () => {
        if (viaProxy) return tunnelPost();
        try {
          return await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers, body: '{}' });
        } catch (error) {
          if (!retryable(error) || !trustedProxy || !tunnelable) throw error;
          viaProxy = true;
          return tunnelPost();
        }
      };
      for (let attempt = 0; attempt < 30; attempt++) {
        response = await post();
        if (response.status !== 409) break;
        await response.arrayBuffer();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!response.ok) {
        diagnostic(response.status === 401 || response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
      } else {
      const result = await response.json();
      if (result.status === 'unavailable') {
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in Paperclip';
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      if (result.status === 'available' && configReady) {
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
  }
  // Sandboxes hand git its proxy auth mode through GIT_CONFIG_PARAMETERS, which
  // is cleared above. Without it git's CONNECT to an authenticating proxy fails.
  const gitProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  if (/^https?:\/\/[^/@]+@/i.test(gitProxy)) {
    const index = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0;
    env['GIT_CONFIG_KEY_' + index] = 'http.proxyAuthMethod';
    env['GIT_CONFIG_VALUE_' + index] = 'basic';
    env.GIT_CONFIG_COUNT = String(index + 1);
  }
  // Only this invocation and its children inherit the captured credential.
  // Its Git children use the real binary, so steering cannot split a gh operation.
  env.PATH = originalPath.join(path.delimiter);
  // Nested shell aliases must not reload the parent launcher profile and
  // recapture a newer identity. All ordinary descendants stay in this operation.
  env.ZDOTDIR = configDirectory;
  env.BASH_ENV = '/dev/null';
  env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
  const child = spawn(executable, process.argv.slice(2), { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code === null ? 128 : code; });
}
main().catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = "";
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes";
  env.SSH_AUTH_SOCK = "";
  env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
  return env;
}
