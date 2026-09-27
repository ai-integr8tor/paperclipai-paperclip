import { and, eq, inArray } from "drizzle-orm";
import { agents, companies, issues, type Db } from "@paperclipai/db";
import type { DecisionBrief } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export const DECISION_BRIEF_REQUIRED_MESSAGE =
  "This company requires a decision brief for human-facing questions. Add brief.whatIsHappening, brief.whyStopped and brief.whatWeNeed.";

function uniqueIds(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/**
 * Enforces the company's decision-brief policy and keeps `relatedWork`
 * references inside the company boundary. Call it after any idempotency
 * short-circuit so retries of existing records are never rejected.
 */
export function decisionBriefGuard(db: Db) {
  return {
    assertAllowed: async (input: {
      companyId: string;
      brief: DecisionBrief | null | undefined;
      humanFacing: boolean;
    }) => {
      const { companyId, brief, humanFacing } = input;
      if (!brief) {
        if (!humanFacing) return;
        const required = await db
          .select({ required: companies.requireDecisionBrief })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0]?.required ?? false);
        if (required) throw unprocessable(DECISION_BRIEF_REQUIRED_MESSAGE);
        return;
      }

      const issueIds = uniqueIds((brief.relatedWork ?? []).map((entry) => entry.issueId));
      if (issueIds.length) {
        const found = await db
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
        if (found.length !== issueIds.length) {
          throw unprocessable("brief.relatedWork references a task outside this company");
        }
      }

      const agentIds = uniqueIds((brief.relatedWork ?? []).map((entry) => entry.agentId));
      if (agentIds.length) {
        const found = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
        if (found.length !== agentIds.length) {
          throw unprocessable("brief.relatedWork references an agent outside this company");
        }
      }
    },
  };
}
