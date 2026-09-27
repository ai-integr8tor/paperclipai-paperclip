import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber } from "../utils.js";
import {
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
} from "@paperclipai/adapter-utils/server-utils";
import { guardedHttpAdapterFetch } from "../http/remote-fetch.js";

function joinPrompt(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

// Drives an AgentBridge OpenAI-compatible server (Graphene-Lab/AgentBridge)
// through POST /v1/chat/completions. Paperclip renders the task/wake prompt and
// sends it as a single user message; the AgentBridge session_id is carried in the
// run session params so multi-turn heartbeats resume the same conversation.
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runtime, context, onLog } = ctx;
  const baseUrl = asString(config.url, "http://localhost:5290").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("AgentBridge adapter missing url");

  const model = asString(config.model, "default-agent");
  const llmProvider = asString(config.llmProvider, "");
  const apiKey = asString(config.apiKey, "");
  const timeoutMs = asNumber(config.timeoutMs, 0);

  const taskMarkdown = selectPaperclipTaskMarkdown(context, {
    resumedSession: Boolean(runtime?.sessionId),
    includeCommunicationGuidance: false,
  });
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    includeExecutionContract: true,
    conversationMode: context.conversationMode === true,
  });
  const prompt = joinPrompt([wakePrompt, taskMarkdown]);
  if (!prompt) throw new Error("AgentBridge adapter received an empty prompt");

  const sessionId =
    (runtime?.sessionParams?.session_id as string | undefined) ??
    runtime?.sessionId ??
    undefined;

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
  };
  if (sessionId) body.session_id = sessionId;
  if (llmProvider) body.llm_provider = llmProvider;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    // No child process to spawn: signal the dispatch boundary before the request.
    ctx.onDispatch?.();
    const res = await guardedHttpAdapterFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `AgentBridge chat failed with status ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      );
    }

    const json = (await res.json()) as Record<string, any>;
    const content: string = json?.choices?.[0]?.message?.content ?? "";
    const usage = (json?.usage ?? {}) as Record<string, any>;
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const returnedSession: string | null = json?.session_id ?? sessionId ?? null;

    if (content) {
      await onLog("stdout", content.endsWith("\n") ? content : `${content}\n`);
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "agentbridge",
      model: json?.model ?? model,
      summary: `AgentBridge ${model}`,
      usage: {
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0),
        cachedInputTokens: Number(cachedTokens ?? 0),
      },
      usageBasis: "per_run",
      sessionParams: { session_id: returnedSession },
      sessionDisplayId: returnedSession,
      resultJson: { content },
    };
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `AgentBridge chat timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
