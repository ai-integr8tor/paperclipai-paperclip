// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
vi.mock("../lib/router", () => ({
  Link: ({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props} />,
}));
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: vi.fn() } }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: vi.fn() } }));
vi.mock("../api/issues", () => ({
  issuesApi: { recoveryActions: vi.fn(), resolveRecoveryAction: vi.fn() },
}));

describe("stopped task recovery notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const onRetried = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([{ runId: "failed-run", agentId: "agent", status: "failed" }] as never);
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue({
      active: null,
      actions: [],
      referencedByExecutionBlocker: null,
    } as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "legacy_execution_requires_reconciliation",
        nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  it("shows only the requested sentence and Retry, inside a distinct recovery container", () => {
    const notice = container.querySelector('[role="status"][aria-label="Task recovery"]')!;
    expect(notice.textContent).toBe("Automatic recovery of this task stopped.Retry");
    expect(notice.classList.contains("border")).toBe(true);
    expect(notice.classList.contains("bg-muted")).toBe(true);
    expect(notice.querySelector("a")).toBeNull();
  });
  it("keeps the required next action for other reconciliation causes", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "action_outcome_unknown",
        nextAction: "Verify the external action outcome before continuing.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("Verify the external action outcome before continuing.");
    expect(container.textContent).not.toContain("Automatic recovery of this task stopped.");
  });
  it.each(["native_continuation_requires_reconciliation", "native_session_cleanup_quarantined"])("links to the source run instead of offering a retry rejected by %s", async (cause) => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent",
        cause,
        nextAction: "Inspect the original failure and reconcile the previous execution before continuing.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("Recovery needed.");
    expect(container.textContent).not.toContain("Retry");
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("Inspect run");
    expect(link.getAttribute("href")).toBe("/agents/agent/runs/failed-run");
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
  });
  it("retries the exact failed run and refreshes the task", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockResolvedValue({} as never);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(agentsApi.retryFailedRun).toHaveBeenCalledWith("agent", "failed-run", "company");
    expect(onRetried).toHaveBeenCalledOnce();
  });
  it("shows a failed Retry in the same container and allows another attempt", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockRejectedValue(new Error("Environment cleanup is still running."));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Environment cleanup is still running.");
    expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
    expect(onRetried).not.toHaveBeenCalled();
  });
  it("surfaces the settled recovery action the blocker references and resolves it on the task", async () => {
    client.clear();
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue({
      active: null,
      actions: [{ id: "recovery", status: "resolved", cause: "native_event_replay_conflict" }],
      referencedByExecutionBlocker: "recovery",
    } as never);
    vi.mocked(issuesApi.resolveRecoveryAction).mockResolvedValue({} as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: null, agentId: null, cause: "native_event_replay_conflict",
        nextAction: "Verify the external action outcome before continuing.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("Settled recovery action (native_event_replay_conflict) still holds this task. Resolve it to resume.");
    expect(issuesApi.recoveryActions).toHaveBeenCalledWith("task");
    const resolve = [...container.querySelectorAll("button")].find(button => button.textContent === "Resolve recovery")!;
    expect(resolve).toBeTruthy();
    await act(async () => resolve.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(issuesApi.resolveRecoveryAction).toHaveBeenCalledWith("task", {
      actionId: "recovery", outcome: "restored", sourceIssueStatus: "todo",
    });
    expect(onRetried).toHaveBeenCalledOnce();
  });
  it("reports a refused resolution instead of dropping the settled action", async () => {
    client.clear();
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue({
      active: null,
      actions: [{ id: "recovery", status: "resolved", cause: "native_event_replay_conflict" }],
      referencedByExecutionBlocker: "recovery",
    } as never);
    vi.mocked(issuesApi.resolveRecoveryAction).mockRejectedValue(new Error("Board access required"));
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: null, agentId: null, cause: "native_event_replay_conflict",
        nextAction: "Verify the external action outcome before continuing.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    const resolve = [...container.querySelectorAll("button")].find(button => button.textContent === "Resolve recovery")!;
    await act(async () => resolve.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Board access required");
    expect(container.textContent).toContain("Settled recovery action (native_event_replay_conflict) still holds this task.");
    expect(onRetried).not.toHaveBeenCalled();
  });
  it("shows no settled action when the blocker does not reference one", async () => {
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue({
      active: null,
      actions: [{ id: "recovery", status: "resolved", cause: "native_event_replay_conflict" }],
      referencedByExecutionBlocker: null,
    } as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: null, agentId: null, cause: "native_event_replay_conflict",
        nextAction: "Verify the external action outcome before continuing.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.textContent).not.toContain("Settled recovery action");
    expect([...container.querySelectorAll("button")]).toHaveLength(0);
  });
});
