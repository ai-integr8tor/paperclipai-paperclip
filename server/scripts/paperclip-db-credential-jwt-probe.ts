// One-shot operator-side smoke. Never prints the DB URL or issued JWT.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  agents,
  closeRegisteredClients,
  companies,
  createDb,
  heartbeatRuns,
  resolveDatabaseConnectionString,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../src/agent-auth-jwt.js";

const apiUrl = process.argv[2];
if (!apiUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(apiUrl)) {
  throw new Error("Expected a loopback API URL");
}
const dbUrl = resolveDatabaseConnectionString({});
if (!dbUrl || !process.env.PAPERCLIP_DATABASE_URL_FILE || process.env.DATABASE_URL) {
  throw new Error("Expected a file-backed DB source without DATABASE_URL");
}

const db = createDb(dbUrl);
try {
  const [company] = await db.insert(companies).values({
    name: "Synthetic DB credential JWT smoke",
    issuePrefix: `SJ${randomUUID().replace(/-/g, "").slice(0, 8)}`,
  }).returning({ id: companies.id });
  if (!company) throw new Error("Company seed failed");
  const [agent] = await db.insert(agents).values({
    companyId: company.id,
    name: "Synthetic JWT agent",
    role: "general",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
  }).returning({ id: agents.id });
  if (!agent) throw new Error("Agent seed failed");
  const runId = randomUUID();
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId: company.id,
    agentId: agent.id,
    status: "running",
  });
  const jwt = createLocalAgentJwt(agent.id, company.id, "codex_local", runId);
  if (!jwt) throw new Error("Run-scoped JWT issuance failed");

  const agentCode = `
    const forbidden = Object.keys(process.env).filter(k =>
      k === "DATABASE_URL" || k === "DATABASE_MIGRATION_URL" ||
      k === "PAPERCLIP_DATABASE_URL_FILE" || k === "PAPERCLIP_AGENT_JWT_SECRET" ||
      /^PG[A-Z0-9_]+$/.test(k));
    if (forbidden.length) throw new Error("agent DB or signing env leak");
    const { PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID, EXPECTED_AGENT_ID } = process.env;
    const response = await fetch(PAPERCLIP_API_URL + "/api/agents/me", {
      headers: { Authorization: "Bearer " + PAPERCLIP_API_KEY, "X-Paperclip-Run-Id": PAPERCLIP_RUN_ID },
    });
    if (response.status !== 200) throw new Error("JWT API HTTP " + response.status);
    const body = await response.json();
    if (body.id !== EXPECTED_AGENT_ID) throw new Error("JWT resolved a different agent");
    console.log("Run-scoped JWT agent API HTTP 200; agent DB env keys 0");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", agentCode], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.PAPERCLIP_JWT_AGENT_HOME ?? "/nonexistent",
      PAPERCLIP_API_URL: apiUrl,
      PAPERCLIP_API_KEY: jwt,
      PAPERCLIP_RUN_ID: runId,
      EXPECTED_AGENT_ID: agent.id,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  if (child.status !== 0) {
    throw new Error(`Agent JWT API check failed (exit ${child.status}): ${child.stderr.trim()}`);
  }
  process.stdout.write(child.stdout);
  console.log("Run-scoped JWT issuance with file-backed DB source passed");
} finally {
  await closeRegisteredClients(dbUrl);
}
