import { and, eq, inArray } from "drizzle-orm";
import { agents, companies, issues, type Db } from "@paperclipai/db";
import type { DecisionBrief } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export const DECISION_BRIEF_REQUIRED_MESSAGE =
  "This company requires a decision brief for human-facing questions. Add brief.whatIsHappening, brief.whyStopped and brief.whatWeNeed.";

/**
 * Server-authored brief for the system-generated attention-archive proposal
 * decision (`POST /companies/:companyId/decision-archive-proposals`). That
 * route has no user-supplied `brief` field, but the created decision is
 * human-facing (a standalone decision), so `decisionBriefGuard` requires one
 * whenever the company opts into `requireDecisionBrief`. This helper is pure
 * so it can be unit-tested without pulling in the route module's heavier
 * dependencies (Router, attentionService, authorizationService, etc.).
 */
export function buildArchiveProposalBrief(count: number): DecisionBrief {
  const items = `${count} aging decision${count === 1 ? "" : "s"}`;
  return {
    version: 1,
    whatIsHappening: `An agent reviewed the aging decisions shelf and proposes archiving ${items}. Each item and the agent's reason are listed below.`,
    whyStopped: "Archiving removes these items from the Decisions feed, so a person must confirm before anything is hidden.",
    whatWeNeed: "Archive the reviewed items, or keep them on the shelf. Keeping them changes nothing.",
  };
}

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
