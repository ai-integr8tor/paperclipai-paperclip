import { z } from "zod";
import type { DecisionBrief } from "../types/decision-brief.js";
import { multilineTextSchema } from "./text.js";

export const DECISION_BRIEF_LIMITS = {
  paragraph: 1200,
  recommendation: 400,
  relatedWorkNote: 300,
  relatedWorkItems: 8,
} as const;

const briefText = (max: number) => multilineTextSchema.pipe(z.string().trim().min(1).max(max));

export const decisionBriefSchema = z
  .object({
    version: z.literal(1),
    whatIsHappening: briefText(DECISION_BRIEF_LIMITS.paragraph),
    whyStopped: briefText(DECISION_BRIEF_LIMITS.paragraph),
    whatWeNeed: briefText(DECISION_BRIEF_LIMITS.paragraph),
    recommendation: briefText(DECISION_BRIEF_LIMITS.recommendation).optional(),
    relatedWork: z
      .array(
        z
          .object({
            issueId: z.string().guid().optional(),
            agentId: z.string().guid().optional(),
            note: briefText(DECISION_BRIEF_LIMITS.relatedWorkNote),
          })
          .strict(),
      )
      .max(DECISION_BRIEF_LIMITS.relatedWorkItems)
      .optional(),
  })
  .strict();

// Compile-time guard: the parsed shape must stay assignable to the shared type.
const _decisionBriefShapeCheck: (value: z.infer<typeof decisionBriefSchema>) => DecisionBrief = (value) => value;
void _decisionBriefShapeCheck;
