import { createHash, randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { captureFirstTaskAttachments } from "./first-task-attachments.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi } from "./user-actions.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution, RunnerTaskFixture } from "./types.js";

type Row = Record<string, any>;
export const instructionNonceLine = (nonce: string) => `Instruction persistence nonce: ${nonce}\n`;
export const instructionPersistenceTask: RunnerTaskFixture = {
  id: "private-copy-persists", label: "Private instruction edit survives a fresh task",
  groups: [], workMode: "standard", flow: "instruction_persistence",
  expectedRunCount: 3, attemptTimeoutMs: { local: 20 * 60_000, daytona: 20 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Persist private instructions ${nonce}`,
  buildVisibleMarker: () => "INSTRUCTIONS-VERIFIED",
  buildPrompt: nonce => [
    "Edit your own registered writable agent instruction entry with ordinary filesystem tools. The runtime guidance gives its exact private path.",
    `Preserve its existing bytes and append exactly this UTF-8 suffix, represented as a JSON string: ${JSON.stringify(`\n${instructionNonceLine(nonce)}`)}`,
    "Decode the JSON string once and append those bytes. Do not trim or normalize the existing file and do not add another blank line or separator.",
    "Do not use update_agent_instructions, restore_agent_instructions, or an instructions API to save it. Do not edit repository AGENTS.md or the read-only loaded bundle.",
    "Reply only Instruction copy edited without printing filesystem paths, then complete this task after the file edit. Paperclip will collect it after the provider stops; do not claim it has already persisted. Do not create further tasks.",
  ].join("\n"),
  buildMatchers: () => [], // Independent public revision and attachment oracle below.
};

export function gradeInstructionPersistence(input: { before: Row; after: Row; firstRunId: string; expectedContent: string; proof: Row | undefined; expectedProof: string }) {
  return [
    { id: "new-cleanup-revision", passed: Boolean(input.before.revision?.id && input.after.revision?.id && input.after.revision.id !== input.before.revision.id && input.after.revision.source === "cleanup" && input.after.revision.sourceRunId === input.firstRunId) },
    { id: "exact-canonical-bytes", passed: input.after.content === input.expectedContent && input.after.revision?.contentHash === createHash("sha256").update(input.expectedContent).digest("hex") },
    { id: "fresh-task-downloaded-proof", passed: input.proof?.contentVerified === true && input.proof.body === input.expectedProof },
  ].map(check => ({ ...check, detail: check.passed ? `${check.id} verified independently` : `${check.id} missing or incorrect` }));
}

export async function runInstructionPersistenceFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  secrets: readonly string[]; deadlineAt: number;
  restart(): Promise<void>;
  observe(issue: Row, runs: Row[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, data: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  // Fixture names contain the campaign nonce. Use an unrelated value that the
  // fresh task can obtain only from the saved entry (or forbidden task history).
  const persistedNonce = randomBytes(16).toString("hex");
  const filePath = `/api/agents/${fixtures.agent.id}/instructions-bundle/file?path=AGENTS.md`;
  const before = await api.get<Row>(filePath);
  if (typeof before.content !== "string" || !before.revision?.id) throw new Error("Managed instructions must expose a canonical baseline revision");
  const expectedContent = `${before.content}\n${instructionNonceLine(persistedNonce)}`;
  let issue: Row = {};
  let runs: Row[] = [];
  async function create(title: string, prompt: string) {
    await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title, prompt, workMode: "standard", projectName: fixtures.project?.name });
    const found = await pollUntil({ label: `instruction task ${title}`, deadlineAt: input.deadlineAt,
      load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(row => row.title === title), accept: row => Boolean(row) });
    if (!found) throw new Error("Browser-created instruction task missing");
    issue = found;
    input.observe(issue, runs);
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  }
  async function settle(count: number) {
    await pollUntil({ label: `instruction run ${count} completed`, deadlineAt: input.deadlineAt,
      load: async () => {
        issue = await api.get<Row>(`/api/issues/${issue.id}`);
        const listed = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`);
        runs = await Promise.all(listed.map(row => api.get<Row>(`/api/heartbeat-runs/${row.id}`)));
        runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        input.observe(issue, runs);
        return { issue, runs };
      },
      accept: state => state.issue.status === "done" && state.runs.length === count && state.runs.every(row => row.status === "succeeded"),
      reject: state => state.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Instruction task provider run failed" : state.runs.length > count ? "Instruction task dispatched an extra run" : undefined,
    });
    expect(runs.every(row => row.runtimeMode === execution.profile.expectedRuntimeMode)).toBe(true);
    await page.reload();
    await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: "Change status (current: Done)", exact: true })).toBeVisible();
  }
  await create(execution.task.buildTitle(nonce), execution.task.buildPrompt(persistedNonce));
  await settle(1);
  const firstRunId = runs[0]!.id;
  const after = await pollUntil({ label: "stopped instruction cleanup revision", deadlineAt: Math.min(input.deadlineAt, Date.now() + 30_000),
    load: () => api.get<Row>(filePath), accept: row => row.content === expectedContent && row.revision?.sourceRunId === firstRunId });
  const events = await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${firstRunId}/events?afterSeq=${afterSeq}&limit=${limit}`));
  expect(events.some(row => row.eventType === "instruction_save" && row.payload?.state === "saved")).toBe(true);
  await input.evidence("instruction-first-save.json", { before, after, run: runs[0], events });
  await input.capture("instruction-edited", "Private instructions saved after provider stop", "instruction-edited.png");
  // A new server and a new issue cannot pass by retaining model conversation.
  await input.restart();
  expect((await api.get<Row>(filePath)).content).toBe(expectedContent);
  await create("Read persisted instructions", [
    "Read your own loaded agent instruction entry (or its current registered private copy) using ordinary filesystem tools.",
    "Find the line beginning 'Instruction persistence nonce: '. Copy that entire line plus one final newline into instruction-proof.txt. Do not infer the value from this task title or other task history. Do not change your instructions.",
    "Upload instruction-proof.txt as a text/plain task attachment named instruction-proof.txt using the normal artifact workflow. A local file alone is insufficient.",
    `Reply with exactly ${execution.task.buildVisibleMarker(nonce)} and complete the task.`,
  ].join("\n"));
  await settle(2);
  const attachments = await captureFirstTaskAttachments(api, [{ ...issue, id: String(issue.id) }], input.secrets);
  const proof = attachments.find(row => row.originalFilename === "instruction-proof.txt" || row.name === "instruction-proof.txt");
  const final = await api.get<Row>(filePath);
  expect(final.revision.id).toBe(after.revision.id);
  const checks = gradeInstructionPersistence({ before, after, firstRunId, expectedContent, proof, expectedProof: instructionNonceLine(persistedNonce) });
  await expect(page.getByTestId("task-chat-agent-bubble").filter({ hasText: execution.task.buildVisibleMarker(nonce) }).last()).toBeVisible();
  await input.capture("final-state", "Fresh task downloaded the persisted instruction nonce", "final-state.png");
  expect(checks.filter(check => !check.passed), "Independent instruction persistence checks").toEqual([]);

  const instructionsUrl = `/${fixtures.company.issuePrefix}/agents/${fixtures.agent.id}/instructions`;
  await page.goto(instructionsUrl);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: before.revision.id.slice(0, 8), exact: true }).click();
  await expect(page.getByText("Changes from selected revision to current", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore as new revision", exact: true }).click();
  const restored = await pollUntil({ label: "browser restored instruction revision", deadlineAt: Math.min(input.deadlineAt, Date.now() + 30_000),
    load: () => api.get<Row>(filePath), accept: row => row.content === before.content && row.revision?.source === "restore" && row.revision?.restoredFromRevisionId === before.revision.id });
  expect(restored.revision.parentRevisionId).toBe(after.revision.id);
  checks.push({ id: "browser-history-and-restore", passed: true, detail: "Browser inspected history and restored exact baseline bytes as a new revision" });

  // The provider publishes an ordinary attachment before a bounded command wait.
  // A board edit during that run creates a real CAS conflict at stopped cleanup.
  const conflictSuffix = `\nPreserved instruction candidate: ${nonce}\n`;
  const expectedCandidate = `${restored.content}${conflictSuffix}`;
  await create("Preserve a concurrent instruction edit", [
    `Append exactly this UTF-8 suffix to your current registered writable instruction entry, represented as a JSON string: ${JSON.stringify(conflictSuffix)}`,
    "Decode the JSON string once. Preserve all existing bytes. Do not use an instruction revision tool or instructions API.",
    "After the file edit, upload a text/plain task attachment named instruction-candidate-ready.txt with the text ready. Use the ordinary artifact workflow.",
    "Then execute the ordinary shell command sleep 45 and wait for it to finish. This gives the board time to edit the canonical instructions concurrently. Do not complete the task before that command finishes.",
    "After the wait completes, reply Candidate edit ready and complete the task. Do not change the instructions again or claim that they saved.",
  ].join("\n"));
  await pollUntil({ label: "provider staged concurrent instruction edit", deadlineAt: input.deadlineAt,
    load: () => api.get<Row[]>(`/api/issues/${issue.id}/attachments`),
    accept: rows => rows.some(row => row.originalFilename === "instruction-candidate-ready.txt" || row.name === "instruction-candidate-ready.txt") });
  const active = await api.get<Row[]>(`/api/issues/${issue.id}/runs`);
  expect(active.some(row => row.status === "running")).toBe(true);
  const boardContent = `${restored.content}\nConcurrent board instruction edit.\n`;
  const boardResponse = await api.request.put(`/api/agents/${fixtures.agent.id}/instructions-bundle/file`, {
    data: { path: "AGENTS.md", content: boardContent, baseRevisionId: restored.revision.id },
  });
  expect(boardResponse.ok()).toBe(true);
  const board = await boardResponse.json() as Row;
  await settle(3);
  const conflictRunId = runs[2]!.id;
  const candidatePath = `/api/agents/${fixtures.agent.id}/instructions-bundle/candidates`;
  const candidates = await pollUntil({ label: "preserved instruction conflict", deadlineAt: Math.min(input.deadlineAt, Date.now() + 30_000),
    load: () => api.get<Row[]>(candidatePath), accept: rows => rows.some(row => row.runId === conflictRunId && row.state === "conflict") });
  const candidate = candidates.find(row => row.runId === conflictRunId)!;
  expect(candidate.content).toBe(expectedCandidate);
  expect(candidate.baseRevisionId).toBe(restored.revision.id);
  expect((await api.get<Row>(filePath)).content).toBe(boardContent);
  await page.goto(instructionsUrl);
  await page.getByRole("button", { name: "Review preserved edits", exact: true }).click();
  await page.getByText("Compare current instructions", { exact: true }).click();
  await expect(page.locator("details pre")).toHaveText(boardContent);
  // Explicitly choose the preserved candidate after reviewing the board edit.
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const resolved = await pollUntil({ label: "browser resolved preserved instruction candidate", deadlineAt: Math.min(input.deadlineAt, Date.now() + 30_000),
    load: () => api.get<Row>(filePath), accept: row => row.content === expectedCandidate && row.revision?.parentRevisionId === board.revision.id && row.revision?.source === "api" });
  await expect(page.getByRole("button", { name: "Review preserved edits", exact: true })).toHaveCount(0);
  expect((await api.get<Row[]>(candidatePath)).some(row => row.runId === conflictRunId)).toBe(false);
  checks.push({ id: "browser-preserved-conflict-resolution", passed: true, detail: "Concurrent canonical edit survived cleanup; browser review and explicit save resolved the preserved candidate" });
  await input.evidence("api-state.json", { issue, runs, checks, canonicalInstructions: resolved, attachments });
  await input.evidence("instruction-persistence.json", { checks, before, after, final, restored, board, candidate, resolved, runs, attachments });
  await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  await input.capture("conflict-resolved", "Stopped run preserved its concurrent instruction edit for explicit review", "conflict-resolved.png");
  return { issue, runs, checks };
}
