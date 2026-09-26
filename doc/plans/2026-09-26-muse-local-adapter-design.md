# `muse_local` adapter: Muse Code subscription support

Status: design approved 2026-09-26, spec awaiting review.

## Goal

Run Paperclip agents on Meta's Muse Code CLI, billed to the operator's Muse
Code subscription, with the same level of support Paperclip gives Codex and
Claude subscriptions: a local adapter that runs the CLI, and an in-app device
login that stores a per-company credential.

Success means:

- An operator picks "Muse Code" as an agent's adapter, clicks "Log in", approves
  a code on `auth.meta.com`, and the agent's next heartbeat runs on Muse.
- Two companies logged in to two different Meta accounts never share a
  credential.
- A host that already ran `muse login` works without the in-app login.
- A Paperclip server on macOS never reads or overwrites the operator's own
  Muse keychain entry.

## Verified CLI facts (Muse Code 1.4.0-R4161.1, probed 2026-09-26)

- `muse` is a bash launcher (`~/.local/bin/muse`) that execs
  `muse-bin-<version>` next to it. `MUSE_LAUNCHER_INSTALL=1 muse` installs the
  binary without logging in; `MUSE_NO_AUTO_UPDATE=1` stops background updates.
  Install: `curl -fsSL https://api.meta.ai/muse-launcher.sh`.
- `muse login` is an OAuth device flow against `auth.meta.com`. Run headless
  (stdin `/dev/null`, stdout not a TTY), it prints on stdout:

  ```
  Open this page to sign in:
    https://auth.meta.com/oauth/device/?code=SVTC-XZCS
  confirm this code matches:
    SVTC-XZCS

  Waiting for approval…
  Logged in. Credential saved to <XDG_CONFIG_HOME>/muse/auth.json.
  Model API access verified.
  ```

- Credential storage defaults to the OS keychain on every platform. On headless
  Linux it fails after a successful approval:
  `login succeeded but saving failed: … keychain write failed (internal error -2147483648)`.
  `TBH_CREDENTIAL_BACKEND=file` makes the CLI write `auth.json` (mode 0600)
  instead. Other values (`plaintext`, `insecure-file`, `keychain`) fall back to the keychain.
- A file-backend login writes:
  `{schema_version: 1, providers: {meta: {mechanism: "oauth", obtained_via: "device_code", api_base_url, api_key, access_token, user_email, user_full_name}}}`.
  `api_key` is 48 characters with the prefix `LLM|`. There is no expiry and no
  refresh token.
- `META_API_KEY` takes priority over any stored login. `muse exec` with only
  `META_API_KEY` set and an empty `XDG_CONFIG_HOME` / `XDG_DATA_HOME` succeeds.
- The CLI honours `XDG_CONFIG_HOME` (credentials, settings, trust) and
  `XDG_DATA_HOME` (sessions, session index, skills, plugins).
- `muse exec --json` writes MSP records as JSONL on stdout: every line has
  `schema_version`, `id`, `stream: {kind: "session", id}`, `sequence`,
  `recorded_at`, `record_type` (`event`, `status`, `reconciliation`). Human
  chatter goes to stderr. `muse schema` exports the full wire schema.
  `--no-session-log` disables the session store, so resume needs logs on.

## Architecture

### 1. Adapter package `packages/adapters/muse-local`

Modelled on `grok-local` (smallest adapter with device login) and
`kimi-local` (CLI execution). Exports follow the other local adapters:
`type = "muse_local"`, `label = "Muse Code"`, `models`,
`agentConfigurationDoc`, `SANDBOX_INSTALL_COMMAND`, and `server` / `ui` /
`cli` entry points.

- **Models:** `muse-spark-1.3` (default) and `muse-spark-1.3-contributor`.
  `reasoningEffort` config: `none|minimal|low|medium|high|xhigh|max|ultra`,
  default `high`.
- **`execute`:** writes the rendered prompt to a temp file and runs
  `muse exec --json --model <m> --reasoning-effort <e> --workspace <cwd>
  --approval-mode never --session-id <uuid> --prompt-file <file> [extraArgs]`
  with the environment from section 3. It streams stdout through `parse.ts`
  into Paperclip transcript entries, usage, and the final answer. Exit code
  and a missing final answer map to run errors, the same way `kimi-local`
  does.
- **Sessions:** the session codec stores `{sessionId, cwd}`. A heartbeat
  reuses `sessionId` when the stored cwd matches the current cwd; otherwise
  it mints a fresh UUID. Muse's session store lives in the per-agent
  `XDG_DATA_HOME`, so resume survives across heartbeats.
- **`parse.ts`:** a pure JSONL parser over MSP records, built from
  `muse schema` output and the recorded fixture
  `src/server/__fixtures__/exec-basic.jsonl` (recorded copy: `doc/plans/2026-09-26-muse-exec-basic.jsonl`). Unknown `record_type` values are
  ignored, not fatal.
- **Skills:** Paperclip skills are linked into the agent's
  `XDG_DATA_HOME/muse/skills/`, following `grok-local/src/server/skills.ts`.
- **`testEnvironment`:** reports the CLI path and version, and whether a
  credential source exists (company secret, `META_API_KEY`, or a host login).
  It never prints the key.
- **UI:** a config form (model, reasoning effort, cwd, command, extraArgs,
  env, timeouts) and the login affordance flag, following `grok-local/src/ui`.

### 2. Device login: profile `muse_local`

Added next to `codex_local` and `grok_local` in
`server/src/services/device-login-service.ts` (allow-list and profile map).

- **Command:** `muse login`, run in the login sandbox with
  `XDG_CONFIG_HOME=<login scratch home>/config`,
  `XDG_DATA_HOME=<login scratch home>/data`, `TBH_CREDENTIAL_BACKEND=file`,
  `MUSE_NO_AUTO_UPDATE=1`, stdin closed.
- **Prompt parser** `parseMuseDeviceLoginPrompt` (a pure function, same rules as
  the Grok parser): strip ANSI CSI; accept only origin `https://auth.meta.com`,
  path `/oauth/device/`, exactly one query key `code`, no fragment; the code
  matches `^[A-Z0-9]{4}-[A-Z0-9]{4}$` and equals the code on its own line after
  `confirm this code matches:`. It never logs or throws input bytes.
- **Completion:** the profile treats `Logged in.` plus exit 0 as success. It also
  requires `Model API access verified.`, which is the CLI's own readiness check.
- **Promotion** (`adapter-auth-promotion.ts`): read
  `<scratch>/config/muse/auth.json` and assert its shape: a `providers.meta`
  object, `mechanism === "oauth"`, and an `api_key` matching `^LLM\|` with a
  length of 40–128 characters. Store only `api_key` as the company secret
  `MUSE_API_KEY` (upsert; the same decision rules as Grok for user-initiated
  vs background logins). Discard `access_token` and the user's name and email.
  Delete the scratch home in a `finally` block.

### 3. Run-time credential and environment

`execute` builds the child environment as follows:

- `META_API_KEY` = the company secret `MUSE_API_KEY`, when present.
- `XDG_CONFIG_HOME` and `XDG_DATA_HOME` = per-agent directories under the
  Paperclip instance data dir (`…/muse/<companyId>/<agentId>/{config,data}`),
  created 0700.
- `TBH_CREDENTIAL_BACKEND=file` and `MUSE_NO_AUTO_UPDATE=1`, always.

With the company secret, the run never touches any keychain or the operator's
`~/.config/muse`. **Host-login fallback:** when no company secret exists and
`useHostLogin` is true (the default), `XDG_CONFIG_HOME` is left unset so the
CLI uses the host user's own login (keychain on macOS). `XDG_DATA_HOME` stays
per-agent either way.

A 401 or `Your saved Meta credentials are invalid` / `No Meta credentials
were found` fails the run with the error code `muse_auth_required` and a
"log in to Muse again" message. There is no retry.

### 4. Wiring

- `server/src/adapters/registry.ts`: register execute, skills, testEnvironment,
  sessionCodec, and login command/parser.
- `server/src/services/device-login-service.ts`: add `muse_local` to the
  reachable allow-list and profile map; `homeEnvVar` is not used for Muse. The
  profile passes the XDG and backend variables from section 2 instead.
- UI adapter picker and login button: the same registration points as `grok_local`.
- Package manifests, workspace, tsconfig references, changelog.

## Security

- Muse keys are stored only as company secrets. They never go into
  config JSON, logs, transcripts, thrown errors, or run results. Add `LLM|…`
  to `server/src/middleware/redact-sensitive.ts` patterns.
- The parser rejects any URL that isn't `https://auth.meta.com/oauth/device/`,
  so a tampered CLI cannot send the operator to a phishing page.
- The scratch login home is deleted after promotion whether it succeeds or not.

## Testing

- `device-login-parse.test.ts`: captured plain and ANSI-coloured prompts;
  negatives for wrong origin, wrong path, extra query key, fragment,
  mismatched code, and bad code shape.
- `adapter-auth-promotion.test.ts`: accepts a valid file credential; rejects
  keychain-storage stubs, a missing `api_key`, an API-key-only (`auth set`)
  credential, and an oversized file; checks that the scratch home is deleted.
- `parse.test.ts`: the recorded `exec-basic.jsonl` fixture plus a tool-call
  fixture recorded during implementation.
- `execute.test.ts`: a fake `muse` script checks the argv, the env precedence
  (secret beats host login, XDG dirs), session resume, and `muse_auth_required`
  mapping.
- Live smoke test: one heartbeat on the operator's subscription through the
  in-app login.

## Out of scope

- Quota and usage display (Codex/Claude `quota.ts`): add it once Muse has a
  usage endpoint that is known to work with the subscription key.
- The ACP/MSP persistent engine (`muse serve`): the CLI engine only for v1.
- Remote/sandbox execution beyond what `adapter-utils` gives local adapters
  for free.
