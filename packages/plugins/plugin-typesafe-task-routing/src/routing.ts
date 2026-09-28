import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JsonValue } from "@typesafe-ai/sdk";
import type { Issue, PluginContext, Project } from "@paperclipai/plugin-sdk";
import {
  DEPARTMENT_INSTRUCTIONS,
  DESTINATION_CRITERIA,
  DESTINATIONS,
  MODEL_VERSION,
  POLICY_VERSION,
  QUESTION_VERSION,
  ROUTE_MIN_CONFIDENCE,
  SUFFICIENCY_INSTRUCTIONS,
  TIE_MARGIN,
  type DestinationKey,
} from "./policy.js";

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const GATED_ACTION_PATTERN = /\b(refund|capture|void|authorize|re-?auth|store credit|gift card|payment|gateway|send|email|text|sms|publish|public reply|direct message)\b/i;
const ACTION_REQUEST_PATTERN = /\b(execute|process|issue|apply|run|send|publish|post|reply|change|update|write|approve)\b/i;
const ROUTING_ENTITY_TYPE = "typesafe-routing-recommendation";
const inFlightEvaluations = new Map<string, Promise<string>>();

export type RoutingDecision = {
  model: string;
  department: {
    type: "choice";
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
  };
  sufficiency: { type: "noul"; noul: number };
  usage: { input_tokens: number; output_tokens: number };
};

export interface RoutingDecisionClient {
  decide(state: Record<string, JsonValue>, options: { timeoutMs: number; maxRetries: number }): Promise<RoutingDecision>;
}

type RoutingConfig = { enabled: boolean; timeoutMs: number; maxRetries: number };

type RecommendationRecord = {
  issueId: string;
  inputRevision: string;
  policyVersion: string;
  questionVersion: string;
  requestedModelVersion: string;
  returnedModelVersion: string | null;
  rawDecision: string | null;
  effectiveDecision: DestinationKey | null;
  recommendedAgentId: string | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  sufficiencyProbability: number | null;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  status: "recommended" | "failed";
  reason: string;
};

const TYPESAFE_API_ORIGIN = "https://api.typesafe.ai";
const ONECLI_PLACEHOLDER_API_KEY = "onecli-gateway-managed";

export function createOneCliGatewayFetch(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): (input: string, init?: RequestInit) => Promise<Response> {
  if (env.ONECLI_GATEWAY !== "true") throw new Error("OneCLI gateway is not enabled for this worker");
  if (!env.HTTPS_PROXY) throw new Error("OneCLI HTTPS proxy is not configured for this worker");
  if (env.NODE_USE_ENV_PROXY !== "1") throw new Error("Node environment proxy support is not enabled for this worker");
  if (!env.NODE_EXTRA_CA_CERTS) throw new Error("OneCLI CA trust is not configured for this worker");

  return async (input, init) => {
    const url = new URL(input);
    if (url.origin !== TYPESAFE_API_ORIGIN) throw new Error("TypeSafe transport refused an unexpected origin");
    await access(env.NODE_EXTRA_CA_CERTS!);
    return fetchImpl(input, init);
  };
}

export function createTypeSafeDecisionClient(): RoutingDecisionClient {
  const gatewayFetch = createOneCliGatewayFetch();
  return {
    async decide(state, options) {
      const client = new TypeSafeClient({
        apiKey: ONECLI_PLACEHOLDER_API_KEY,
        defaultModel: MODEL_VERSION,
        fetch: gatewayFetch,
        timeout: options.timeoutMs,
        retry: { maxRetries: options.maxRetries },
        logLevel: "warn",
      });
      const result = await client.systemOne({
        model: MODEL_VERSION,
        state,
        questions: {
          department: choice(DEPARTMENT_INSTRUCTIONS, DESTINATION_CRITERIA),
          sufficiency: noul(SUFFICIENCY_INSTRUCTIONS, {
            true: "The supplied information identifies exactly one primary department.",
            false: "The request is ambiguous, cross-department without a primary, or lacks routing detail.",
          }),
        },
      });
      return {
        model: result.model,
        department: result.answers.department,
        sufficiency: result.answers.sufficiency,
        usage: result.usage,
      };
    },
  };
}

function numberConfig(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function normalizeConfig(raw: Record<string, unknown>): RoutingConfig {
  return {
    enabled: raw.enabled === true,
    timeoutMs: numberConfig(raw.timeoutMs, 5000, 1000, 15000),
    maxRetries: numberConfig(raw.maxRetries, 1, 0, 2),
  };
}

function hasPrescribedOwner(project: Project | null, goal: unknown): boolean {
  const projectOwner = project && "leadAgentId" in project ? project.leadAgentId : null;
  const goalOwner = goal && typeof goal === "object" && "ownerAgentId" in goal
    ? (goal as { ownerAgentId?: unknown }).ownerAgentId
    : null;
  return typeof projectOwner === "string" || typeof goalOwner === "string";
}

export function eligibilityReason(issue: Issue, project: Project | null, goal: unknown): string | null {
  if (issue.assigneeAgentId || issue.assigneeUserId) return "explicit_assignment";
  if (TERMINAL_STATUSES.has(issue.status) || issue.hiddenAt) return "terminal_or_hidden";
  if (issue.parentId) return "child_issue";
  if (hasPrescribedOwner(project, goal)) return "prescribed_owner";
  const text = `${issue.title}\n${issue.description ?? ""}`;
  if (GATED_ACTION_PATTERN.test(text) && ACTION_REQUEST_PATTERN.test(text)) return "governed_action";
  return null;
}

function inputState(issue: Issue, project: Project | null): Record<string, JsonValue> {
  return {
    issue: {
      title: issue.title,
      description: issue.description ?? "",
      project: issue.projectId ? { id: issue.projectId, name: project?.name ?? null } : null,
    },
    routingPolicy: {
      version: POLICY_VERSION,
      destinations: DESTINATION_CRITERIA,
    },
  };
}

export function computeInputRevision(state: Record<string, JsonValue>): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function isDestination(value: string): value is DestinationKey {
  return Object.prototype.hasOwnProperty.call(DESTINATIONS, value);
}

function resolveDecision(decision: RoutingDecision): { destination: DestinationKey; reason: string } {
  if (decision.model !== MODEL_VERSION) return { destination: "needs_triage", reason: "unexpected_model" };
  if (decision.department.type !== "choice" || decision.sufficiency.type !== "noul") {
    return { destination: "needs_triage", reason: "invalid_response_type" };
  }
  if (!isDestination(decision.department.choice)) return { destination: "needs_triage", reason: "unknown_destination" };
  const probabilities = Object.entries(decision.department.probabilities)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] <= 1)
    .sort((a, b) => b[1] - a[1]);
  if (
    probabilities.length < 2 ||
    probabilities.length !== Object.keys(decision.department.probabilities).length ||
    !Object.prototype.hasOwnProperty.call(decision.department.probabilities, decision.department.choice) ||
    !Number.isFinite(decision.department.confidence) ||
    decision.department.confidence < 0 ||
    decision.department.confidence > 1 ||
    !Number.isFinite(decision.sufficiency.noul) ||
    decision.sufficiency.noul < 0 ||
    decision.sufficiency.noul > 1
  ) {
    return { destination: "needs_triage", reason: "invalid_probabilities" };
  }
  if (decision.sufficiency.noul < 0.5) return { destination: "needs_triage", reason: "insufficient" };
  if ((probabilities[0]?.[1] ?? 0) - (probabilities[1]?.[1] ?? 0) < TIE_MARGIN) {
    return { destination: "needs_triage", reason: "ambiguous" };
  }
  if (decision.department.confidence < ROUTE_MIN_CONFIDENCE || (probabilities[0]?.[1] ?? 0) < ROUTE_MIN_CONFIDENCE) {
    return { destination: "needs_triage", reason: "low_confidence" };
  }
  return { destination: decision.department.choice, reason: "policy_match" };
}

async function record(ctx: PluginContext, issue: Issue, revision: string, recommendation: RecommendationRecord) {
  await ctx.entities.upsert({
    entityType: ROUTING_ENTITY_TYPE,
    scopeKind: "issue",
    scopeId: issue.id,
    externalId: `${issue.id}:${revision}:${POLICY_VERSION}`,
    title: `Routing recommendation for ${issue.identifier ?? issue.id}`,
    status: recommendation.status,
    data: recommendation,
  });
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "unknown_error";
}

async function evaluateAndRecord(
  ctx: PluginContext,
  issue: Issue,
  inputRevision: string,
  state: Record<string, JsonValue>,
  config: RoutingConfig,
  client: RoutingDecisionClient | undefined,
  clientFactory: () => RoutingDecisionClient,
): Promise<string> {
  const startedAt = performance.now();
  try {
    const decisionClient = client ?? clientFactory();
    const decision = await decisionClient.decide(state, config);
    const latencyMs = Math.round(performance.now() - startedAt);
    const resolved = resolveDecision(decision);
    await record(ctx, issue, inputRevision, {
      issueId: issue.id,
      inputRevision,
      policyVersion: POLICY_VERSION,
      questionVersion: QUESTION_VERSION,
      requestedModelVersion: MODEL_VERSION,
      returnedModelVersion: decision.model,
      rawDecision: decision.department.choice,
      effectiveDecision: resolved.destination,
      recommendedAgentId: DESTINATIONS[resolved.destination],
      confidence: decision.department.confidence,
      probabilities: decision.department.probabilities,
      sufficiencyProbability: decision.sufficiency.noul,
      latencyMs,
      usage: { inputTokens: decision.usage.input_tokens, outputTokens: decision.usage.output_tokens },
      status: "recommended",
      reason: resolved.reason,
    });
    return resolved.destination;
  } catch (error) {
    try {
      await record(ctx, issue, inputRevision, {
        issueId: issue.id,
        inputRevision,
        policyVersion: POLICY_VERSION,
        questionVersion: QUESTION_VERSION,
        requestedModelVersion: MODEL_VERSION,
        returnedModelVersion: null,
        rawDecision: null,
        effectiveDecision: null,
        recommendedAgentId: null,
        confidence: null,
        probabilities: null,
        sufficiencyProbability: null,
        latencyMs: Math.round(performance.now() - startedAt),
        usage: null,
        status: "failed",
        reason: errorType(error),
      });
    } catch (recordError) {
      ctx.logger.warn("TypeSafe routing failure record could not be persisted", {
        issueId: issue.id,
        errorType: errorType(recordError),
      });
    }
    ctx.logger.warn("TypeSafe routing evaluation failed open", {
      issueId: issue.id,
      errorType: errorType(error),
    });
    return "failed_open";
  }
}

export async function evaluateIssue(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  client?: RoutingDecisionClient,
  clientFactory: () => RoutingDecisionClient = createTypeSafeDecisionClient,
): Promise<string> {
  try {
    const config = normalizeConfig(await ctx.config.get(companyId));
    if (!config.enabled) return "disabled";

    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) return "missing";
    const project = issue.projectId ? await ctx.projects.get(issue.projectId, companyId) : null;
    const goal = issue.goalId ? await ctx.goals.get(issue.goalId, companyId) : null;
    const ineligible = eligibilityReason(issue, project, goal);
    if (ineligible) return ineligible;

    const state = inputState(issue, project);
    const inputRevision = computeInputRevision(state);
    const externalId = `${issue.id}:${inputRevision}:${POLICY_VERSION}`;
    const existing = await ctx.entities.list({ entityType: ROUTING_ENTITY_TYPE, scopeKind: "issue", scopeId: issue.id, externalId, limit: 1 });
    if (existing.length > 0) return "duplicate";

    const inFlightKey = `${companyId}:${externalId}`;
    const existingEvaluation = inFlightEvaluations.get(inFlightKey);
    if (existingEvaluation) return existingEvaluation;

    const evaluation = evaluateAndRecord(ctx, issue, inputRevision, state, config, client, clientFactory);
    inFlightEvaluations.set(inFlightKey, evaluation);
    try {
      return await evaluation;
    } finally {
      if (inFlightEvaluations.get(inFlightKey) === evaluation) {
        inFlightEvaluations.delete(inFlightKey);
      }
    }
  } catch (error) {
    ctx.logger.warn("TypeSafe routing preflight failed open", {
      issueId,
      errorType: errorType(error),
    });
    return "failed_open";
  }
}
