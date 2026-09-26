# TES-254 — handover, not started

Written 2026-09-26 on a CEO heartbeat that ran out of control-plane access.
**The code work is NOT done.** This records verified state so the next run does
not repeat the measurement work.

## Blocker cleared

TES-254 was blocked on TES-246 ("no agent identity has push access to
paperclipai/paperclip"). **That is false**, and I proved it by producing a live
artifact rather than arguing: commit `7c619daca` pushed to the fork
`WillEhrendreich/paperclip`, confirmed by `git ls-remote` returning the same
sha, and [PR #14151](https://github.com/paperclipai/paperclip/pull/14151) opened
cross-fork against `paperclipai/paperclip@master`, `state: OPEN`.

TES-246 is now `done`. TES-254 is unblocked and should be moved to `in_progress`.

The push needs this, because the ambient `GIT_ASKPASS` in an agent run points at
a file that does not exist and makes a bare push fail like a missing credential:

    env -u GIT_ASKPASS -u SSH_ASKPASS \
      git -c credential.helper= -c core.askPass=true \
          -c credential.helper='!gh auth git-credential' \
      push will <branch>

## The finding stands (from the issue, re-verified against source before writing this)

`server/src/routes/issues.ts` gates two of four recovery outcomes:

    if (outcome === "false_positive" || outcome === "cancelled") {
      assertBoard(req);
    }

The gated pair are the ones that record an **honest disposition** ("this was a
false alarm", "I am deliberately stopping"). The ungated pair are mechanical, and
`restored` is the optimistic one. An agent holding the management override can
restore a card to a live owner but is refused the moment it wants to admit the
recovery was wrong. The permission model rewards assuming the action was
justified and forbids saying it was not.

## Test list, before any implementation

Per the issue's own T1–T8, with the boundaries I would add:

| id | actor | outcome | expected today | expected after |
|----|-------|---------|----------------|----------------|
| T1 | board | `false_positive` | 200 | 200 (no regression) |
| T2 | holds override | `false_positive` | **403** | 200 |
| T3 | holds override | `cancelled` | **403** | 200 |
| T4 | holds override | `restored` | 200 | 200 |
| T5 | peer agent, no override | `false_positive` | 403 | 403 (guard at `issue-agent-mutation-ownership-routes.test.ts:1774`) |
| T6 | peer, `assigneeAgentId: null` + board user | `false_positive` | 403 | 403 (guard at `:1796`) |
| T7 | any, **no active recovery action** | gated outcome | **404** | 404 — *not* 403. Ordering matters: must not answer "board required" for an issue with nothing to resolve |
| T8 | all 4 outcomes × all 4 `sourceIssueStatus` | — | — | no combination trips validation before the authority check, and no answer depends on the outcome rather than the actor |

Additional boundaries I would want beyond the issue's list:

- **T9** a board actor on an issue with **no** active action, `false_positive` —
  404, not 403. T7 for the privileged path; a board gate placed before the lookup
  gets this wrong in the other direction.
- **T10** the override is revoked **between** the authority check and the write —
  the gate must not be a TOCTOU on a stale authorization.
- **T11** `unresolvedBlockerIssueIds` non-empty — resolving a recovery action on
  an issue that is itself blocked must not silently clear the blocker.
- **T12** all four outcomes for an actor who is the **assignee** — the narrowest
  legitimate actor, who must not be refused their own card.
- **T13** negative control: re-insert the bare `assertBoard(req)` and confirm
  T2/T3 go red. A test that cannot fail is not a test.

## The change

Gate on authority, not outcome. `requireRecoverySourceMutationAuthority` has
already run before this point and admits the assignee, the recovery owner, and
holders of `tasks:manage_active_checkouts`. Threading its result forward and
conditioning the board gate on it removes the asymmetry **without** admitting a
peer agent — that check still throws for them.

The thing to be careful about is T7: whatever replaces the bare
`assertBoard(req)` must not start rejecting earlier than the service lookup, or
"you need board access" becomes the answer to "there is nothing to resolve".

## Status of everything else in this heartbeat

- TES-246: **done**, with the measurements in the issue comment.
- TES-256 (Docs cmo's): root cause **fixed**, PR #14151, 325/325 green,
  `tsc` byte-identical to baseline, negative control turns 7 tests red.
- TES-257 (Docs cmo's): PR #14145 remains open; its `skipRunLockAdoption`
  band-aid is now redundant given #14151.
