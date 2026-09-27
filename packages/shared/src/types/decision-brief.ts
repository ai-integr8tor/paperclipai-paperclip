/**
 * Agent-written narrative attached to a human-facing question, decision or
 * approval. Relations (parent, siblings, blockers) are computed by Paperclip
 * and must not be restated here; `relatedWork` is only for links the system
 * cannot see.
 */
export interface DecisionBriefRelatedWork {
  issueId?: string;
  agentId?: string;
  note: string;
}

export interface DecisionBrief {
  version: 1;
  whatIsHappening: string;
  whyStopped: string;
  whatWeNeed: string;
  recommendation?: string;
  relatedWork?: DecisionBriefRelatedWork[];
}
