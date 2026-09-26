# TES-250 test list — drop the same-agent release widening

## The change

`server/src/services/issues.ts`, `release`: remove the `holderIsSameAgent`
admission so a live same-agent sibling run's lock is **not** releasable.
Keep `assertCheckoutOwner`'s `allowSameAgentLiveSibling` on the write path.

## The claim under test (WHY-test, one line)

> Releasing an issue whose checkout is held by a LIVE run must never clear that
> run's lock, no matter who the actor is.

## Cases

### Group A — the drop (release must refuse a live same-agent sibling)

| # | Case | Expect |
|---|------|--------|
| A1 | actor = assignee agent, sibling run LIVE, different runId, POST /release | 409, issue unchanged, `checkoutRunId` still the sibling's |
| A2 | A1 but the issue has other fields (title/status) — no partial write | every field unchanged |
| A3 | A1 and `assigneeAgentId` must NOT be cleared | assignee intact |
| A4 | A1 and `executionRunId` / `executionLockedAt` must NOT be cleared | execution lock intact |
| A5 | A1 must not flip `in_progress` -> `todo` | status still `in_progress` |

### Group B — the fix survives (write path keeps the TES-114 admission)

| # | Case | Expect |
|---|------|--------|
| B1 | same agent, live sibling holds, PATCH title | 200, title written |
| B2 | B1 and the checkout is re-bound to the actor's run | `checkoutRunId == actorRunId` |
| B3 | same agent, live sibling holds, POST /comments | 201 |
| B4 | **negative control**: DIFFERENT agent, live sibling holds, PATCH | 409 `issue_write_assignee_run_lock` |
| B5 | B4 discriminator: refusal names actor != assignee | both ids present and different |
| B6 | B4 leaves the title untouched | title still seeded |
| B7 | service-level: `assertCheckoutOwner` admits same-agent sibling | resolves |
| B8 | service-level: `assertCheckoutOwner` refuses a different agent | rejects 409, details name true actor |

### Group C — the release guard still does its job (must not over-correct)

| # | Case | Expect |
|---|------|--------|
| C1 | actor = assignee, holder is a LIVE run of a DIFFERENT agent, POST /release | 409 |
| C2 | actor = assignee, holder run is TERMINAL, POST /release | 200, lock cleared |
| C3 | actor = assignee, holder run MISSING from table, POST /release | 200, lock cleared |
| C4 | actor = assignee, holder is the actor's OWN run, POST /release | 200 (sameRunLock short-circuits) |
| C5 | actor is NOT the assignee, any holder, POST /release | 409 `Only assignee can release issue` |
| C6 | C5 and the assignee is still set | no field changed |

### Group D — boundaries the P1 reasoning invites

| # | Case | Expect |
|---|------|--------|
| D1 | sibling run is `running` but heartbeat is old (stale heartbeat, still `running` status) | **409** — status is the liveness signal here, not heartbeat age |
| D2 | sibling run is `queued`, not `running` | 409 |
| D3 | sibling run is `completed` | 200 (terminal) |
| D4 | sibling run is `failed` | 200 (terminal) |
| D5 | sibling run is `cancelled` | 200 (terminal) |
| D6 | issue status is `todo`, not `in_progress`, sibling live | the guard block is `in_progress`-gated; assert actual behaviour, not assumed |
| D7 | unicode title + sibling live release | 409, title byte-identical |
| D8 | two releases in a row by the same sibling | both 409, no interleaving corruption |
| D9 | concurrent releases (2 parallel requests) | at most one succeeds, lock never half-cleared |

## Negative controls that must fail if the fix is faked

- **N1** delete only the `throw`, keep the query -> A1 must fail (200 instead of 409)
- **N2** keep the widening but gate it on `false` -> A1 passes, but B4/B5/B8 must still hold
  (proves the drop did not leak into the write path)
- **N3** reuse the PATCH-widening helper in release -> A1 fails
- **N4** make release refuse *everyone* including its own run -> C4 fails

## Verification budget

Targeted: the one same-agent test file + the release tests in
`issues-service.test.ts`. No full workspace typecheck unless a targeted
`tsc` on the touched project fails.
