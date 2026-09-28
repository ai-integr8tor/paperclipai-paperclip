import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import type { DecisionBrief } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { DECISION_BRIEF_REQUIRED_MESSAGE, decisionBriefGuard } from "../services/decision-brief.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

const brief = (extra: Partial<DecisionBrief> = {}): DecisionBrief => ({
  version: 1,
  whatIsHappening: "Doing X for the CTO.",
  whyStopped: "Two valid options.",
  whatWeNeed: "Pick one.",
  ...extra,
});

describePg("decisionBriefGuard", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-brief-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(issues); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => tempDb?.cleanup());

  async function seedCompany(requireDecisionBrief = false) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Brief", issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireDecisionBrief,
    });
    return companyId;
  }
  async function seedIssue(companyId: string) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "T", status: "todo", priority: "medium" });
    return id;
  }
  async function seedAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: "A", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    return id;
  }

  it("allows a missing brief when the flag is off", async () => {
    const companyId = await seedCompany(false);
    await expect(decisionBriefGuard(db).assertAllowed({ companyId, brief: null, humanFacing: true })).resolves.toBeUndefined();
  });

  it("rejects a missing brief for human-facing items when the flag is on", async () => {
    const companyId = await seedCompany(true);
    await expect(decisionBriefGuard(db).assertAllowed({ companyId, brief: undefined, humanFacing: true }))
      .rejects.toMatchObject({ status: 422, message: DECISION_BRIEF_REQUIRED_MESSAGE });
  });

  it("allows a missing brief for agent-facing items when the flag is on", async () => {
    const companyId = await seedCompany(true);
    await expect(decisionBriefGuard(db).assertAllowed({ companyId, brief: null, humanFacing: false })).resolves.toBeUndefined();
  });

  it("accepts relatedWork ids from the same company", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const agentId = await seedAgent(companyId);
    await expect(decisionBriefGuard(db).assertAllowed({
      companyId, humanFacing: true, brief: brief({ relatedWork: [{ issueId, agentId, note: "n" }] }),
    })).resolves.toBeUndefined();
  });

  it("rejects relatedWork issue ids from another company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const foreignIssueId = await seedIssue(otherCompanyId);
    await expect(decisionBriefGuard(db).assertAllowed({
      companyId, humanFacing: true, brief: brief({ relatedWork: [{ issueId: foreignIssueId, note: "n" }] }),
    })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects unknown relatedWork agent ids", async () => {
    const companyId = await seedCompany();
    await expect(decisionBriefGuard(db).assertAllowed({
      companyId, humanFacing: true, brief: brief({ relatedWork: [{ agentId: randomUUID(), note: "n" }] }),
    })).rejects.toMatchObject({ status: 422 });
  });
});
