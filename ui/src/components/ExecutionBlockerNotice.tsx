import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Link } from "../lib/router";

export function ExecutionBlockerNotice({ companyId, issueId, blocker, onRetried }: {
  companyId: string;
  issueId: string;
  blocker: ExecutionBlocker;
  onRetried: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });
  // A settled automatic no-replay hold keeps parking every wake and is not the
  // issue's active recovery action, so the recovery card never shows it. Read the
  // projection that names the record the blocker references, otherwise the
  // operator sees a stopped task with nothing to resolve.
  const { data: recovery } = useQuery({
    queryKey: queryKeys.issues.recoveryActions(issueId),
    queryFn: () => issuesApi.recoveryActions(issueId),
  });
  const settledHoldId = recovery?.referencedByExecutionBlocker ?? null;
  const settledHold = settledHoldId && settledHoldId === blocker.recoveryActionId
    ? recovery?.actions.find(action => action.id === settledHoldId) ?? null
    : null;
  const failedRun = runs?.find(run => run.runId === blocker.runId &&
    ["failed", "timed_out"].includes(run.status));
  const requiresInspection = blocker.cause === "native_continuation_requires_reconciliation" ||
    blocker.cause === "native_session_cleanup_quarantined";
  const refresh = () => {
    onRetried();
    for (const queryKey of [queryKeys.issues.detail(issueId), queryKeys.issues.runs(issueId),
      queryKeys.issues.liveRuns(issueId), queryKeys.issues.activeRun(issueId),
      queryKeys.issues.recoveryActions(issueId)]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  const retry = useMutation({
    mutationFn: () => agentsApi.retryFailedRun(failedRun!.agentId, failedRun!.runId, companyId),
    onSuccess: refresh,
  });
  // Resolving the settled action the blocker references releases the hold and
  // resumes the task; the server records the deciding operator on the action.
  const resolveSettledHold = useMutation({
    mutationFn: (actionId: string) => issuesApi.resolveRecoveryAction(issueId, {
      actionId,
      outcome: "restored",
      sourceIssueStatus: "todo",
    }),
    onSuccess: refresh,
  });
  return (
    <div role="status" aria-label="Task recovery" className="mx-(--sz-execution-blocker-inline) my-(--sz-execution-blocker-block) flex flex-wrap items-center justify-between execution-blocker-notice border border-border bg-muted text-foreground">
      <span>{blocker.cause === "legacy_execution_requires_reconciliation"
        ? "Automatic recovery of this task stopped."
        : `${requiresInspection ? "Recovery needed. " : ""}${blocker.nextAction}`}</span>
      {settledHold ? (
        <span className="w-full text-muted-foreground">
          {`Settled recovery action (${settledHold.cause}) still holds this task. Resolve it to resume.`}
        </span>
      ) : null}
      {requiresInspection && blocker.agentId && blocker.runId && (
        <Button variant="outline" size="sm" asChild>
          <Link to={`/agents/${blocker.agentId}/runs/${blocker.runId}`}>Inspect run</Link>
        </Button>
      )}
      {!requiresInspection && failedRun && (
        <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? "Retrying…" : "Retry"}
        </Button>
      )}
      {settledHold && (
        <Button
          variant="outline"
          size="sm"
          disabled={resolveSettledHold.isPending}
          onClick={() => resolveSettledHold.mutate(settledHold.id)}
        >
          {resolveSettledHold.isPending ? "Resolving…" : "Resolve recovery"}
        </Button>
      )}
      {retry.isError && (
        <p role="alert" className="w-full text-destructive">{retry.error.message}</p>
      )}
      {resolveSettledHold.isError && (
        <p role="alert" className="w-full text-destructive">{resolveSettledHold.error.message}</p>
      )}
    </div>
  );
}
