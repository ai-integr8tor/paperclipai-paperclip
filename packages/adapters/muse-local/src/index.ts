export const type = "muse_local";
export const label = "Muse Code";

export const DEFAULT_MUSE_LOCAL_MODEL = "muse-spark-1.3";

export const models = [
  { id: DEFAULT_MUSE_LOCAL_MODEL, label: "Muse Spark 1.3" },
  { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 (contributor)" },
];

export const MUSE_LOCAL_REASONING_EFFORTS = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
] as const;

export function museLocalReasoningEffortsForModel(_model: string): readonly string[] {
  return MUSE_LOCAL_REASONING_EFFORTS;
}

export const agentConfigurationDoc = `# muse_local agent configuration

Adapter: muse_local

Use when:
- You want Paperclip to run Meta's Muse Code CLI locally on the host machine
- You want Muse sessions resumed across heartbeats via \`--session-id\`
- You want runs billed to a Muse Code subscription (host \`muse login\`) or a Meta API key

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- Muse Code is not installed on the machine that runs Paperclip (install: \`curl -fsSL https://api.meta.ai/muse-launcher.sh | bash\`)

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Muse model id. Defaults to muse-spark-1.3.
- reasoningEffort (string, optional): none|minimal|low|medium|high|xhigh|max|ultra, passed via \`--reasoning-effort\` (CLI default: high)
- command (string, optional): defaults to "muse"
- extraArgs (string[], optional): additional \`muse exec\` args
- env (object, optional): KEY=VALUE environment variables. Bind META_API_KEY to a secret to authenticate without a host login.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`muse exec --json --approval-mode never --trust-workspace\`; Muse's OS sandbox stays on (it allows localhost, so Paperclip API calls work).
- Sessions live in a per-agent XDG_DATA_HOME under the Paperclip instance, so \`--session-id\` resumes across heartbeats when the cwd is unchanged.
- Paperclip stages desired skills into \`.agents/skills\` in the execution workspace for the run.
- META_API_KEY takes priority over the host \`muse login\`. Muse reports no token usage, so runs record zero tokens.
`;
