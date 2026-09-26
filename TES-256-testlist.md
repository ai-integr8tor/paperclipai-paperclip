# TES-256 test list — a sibling run must be able to WRITE without stealing the holder's lock

## The defect

`assertCheckoutOwner` is a **write-authorization** check. The TES-114 fix made it
solve "the assignee can write its own issue" by **rebinding** `checkoutRunId` to
the actor (`adoptStaleCheckoutRun({ allowSameAgentLiveSibling: true })`).

Authorization was implemented as **lock theft**. Consequences, in order of damage:

1. The live holder `R1` is stripped of its own issue mid-flight.
2. `release` then sees `checkoutRunId === actorRunId`, concludes it is releasing
   *its own* lock, and clears assignee + checkout + status. (TES-250's P1.)
3. Any later run, of any agent, can claim the now-unowned issue.

The `skipRunLockAdoption` band-aid (TES-250) removes the trigger on `release` but
leaves the underlying theft intact for every other channel.

## The fix under test

Grant write authorization to a live same-agent sibling **without writing
`checkoutRunId`/`executionRunId`**. Ownership becomes a *return value*, not a
mutation. The lock stays with `R1`; `R2` is authorized for the write and the
holder is untouched.

## Cases

### A. The defect, pinned (RED first)

- **A1** sibling `R2` writes its own issue while `R1` holds the lock → write
  succeeds **and** `checkoutRunId` is still `R1`. *(This is the whole issue.)*
- **A2** sibling `R2` calls `release` → 409; `R1` still holds lock, assignee and
  `in_progress`.
- **A3** a **different agent** `B` calls `release` on `R1`-held issue → 409.
- **A4** a different agent `B` writes → 409. (No cross-agent widening.)

### B. The pre-existing behaviour that must NOT regress

- **B1** the actual holder `R1` writes → allowed.
- **B2** `R1` releases its own lock → allowed, issue returns to `todo`.
- **B3** holder is a **terminal** run (e.g. `succeeded`) → adoption proceeds as
  before; the stale-lock path still works.
- **B4** holder run row is **missing** entirely → `stale` path, adoption proceeds.
- **B5** unowned checkout (`checkoutRunId == null`, `in_progress`, same assignee)
  → adoption still writes the binding as before.

### C. Boundaries and negatives

- **C1** actor run is **terminal** → not authorized. (`actorLive` gate; a
  terminal run must not gain write rights via the sibling path.)
- **C2** issue not `in_progress` (`todo`/`blocked`) → no sibling authorization.
- **C3** issue assigned to a **different** agent → no sibling authorization.
- **C4** `actorRunId == null` (unscoped run) → no sibling authorization.
- **C5** `existingRun.agentId !== actorRun.agentId` while
  `allowSameAgentLiveSibling` is set → no sibling authorization. (The flag is not
  a blanket override.)
- **C6** holder is a `cancelled` run → stale, adoption proceeds.
- **C7** `executionRunId` points elsewhere but `checkoutRunId` is the live
  sibling's → still authorized to write; neither field is overwritten.

### D. Concurrency / ordering (the real risk of a read-only grant)

- **D1** `R1` releases **while** `R2`'s write authorization is being resolved →
  `R2` sees either "authorized" or a clean conflict, never a half-written row.
- **D2** two siblings `R2`, `R3` write concurrently → both authorized, neither
  steals; the lock is still `R1` after both.
- **D3** `R1` releases, then `R2` writes → the row lands in the ordinary
  released state (`todo`, unassigned, unlocked). *Revised during the work:*
  I first wrote this as "the sibling's write must be refused afterwards," which
  asserted a false property — a released issue is idle, and the idle-issue write
  path is pre-existing behaviour with nothing to do with the lock. The property
  that matters is that `R2` never ends up holding a lock it did not
  legitimately acquire.
- **D4** sibling grant is **repeated** (agent retries the same write 3×) →
  idempotent; `checkoutRunId` never becomes `R2`.

### E. Empty / degenerate

- **E1** missing issue row → 404, not a crash.
- **E2** null `assigneeAgentId` on the issue → no sibling grant.
- **E3** `heartbeat_runs` row for the actor is absent → no grant (C1's mirror).

## Negative controls (the test must be able to fail)

- **N1** revert the fix → **A1** and **D4** go red. If they stay green the test
  is not pinning the defect.
- **N2** re-add the `checkoutRunId` write to the sibling path → **A1**, **A2**,
  **D2**, **D4** all go red.

## What "done" means

`A1`–`A4` green against a real DB, `B1`–`B5` still green, `C1`–`C7` green, and
`N1` demonstrably red. A property worth stating plainly: **authorization must
never be a side effect of a write elsewhere.** If a read can change what a
different run is allowed to do, the check is not a check.
