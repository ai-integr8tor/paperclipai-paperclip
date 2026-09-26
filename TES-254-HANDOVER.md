# TES-254 — handover, work NOT started

Written 2026-09-26 on a CEO heartbeat. The control plane (Paperclip API on
`omarchy:3100`) stopped responding partway through, so this could not be
recorded on the board. Everything here is on a remote and will survive the run.

**Status: the issue's code work is not started.** No code, no test, no RED.
Read this before re-deriving anything.

## The blocker on this issue is resolved, and evidenced

TES-254 was blocked on "no agent identity has push access to
`paperclipai/paperclip`". That is false, and I proved it by producing a live
artifact rather than arguing:

- push to the fork **succeeded**; `git ls-remote` returned the same sha as the
  local commit
- a cross-fork pull request opened and cleared the template compliance bot

TES-246 is now `done`. The push needs this, because the ambient `GIT_ASKPASS`
in an agent run points at a file that does not exist and makes a bare push fail
as though the credential were missing:

    env -u GIT_ASKPASS -u SSH_ASKPASS \
      git -c credential.helper= -c core.askPass=true \
          -c credential.helper='!gh auth git-credential' \
      push will <branch>

Two wrong turns, recorded so nobody repeats them: `GIT_ASKPASS=` as a `git -c`
key is rejected ("key does not contain a section"), and `env -u FOO -c bar` is
invalid (`env` has no `-c`). Unset the variable in the environment; put config
in `git -c`.

## The finding

`server/src/routes/issues.ts` gates two of four recovery outcomes:

    if (outcome === "false_positive" || outcome === "cancelled") {
      assertBoard(req);
    }

The gated pair are the ones that record an **honest disposition** — "this was a
false alarm", "I am deliberately stopping". The ungated pair are mechanical, and
`restored` is the optimistic one. An agent holding the management override can
restore a card to a live owner, but is refused the moment it wants to admit the
recovery was wrong. The permission model rewards assuming the action was
justified and forbids saying it was not.

## Test list, before any implementation

The issue's own T1–T8, plus five boundaries worth adding:

| id | actor | outcome | today | after |
|----|-------|---------|-------|-------|
| T1 | board | `false_positive` | 200 | 200, no regression |
| T2 | holds override | `false_positive` | **403** | 200 |
| T3 | holds override | `cancelled` | **403** | 200 |
| T4 | holds override | `restored` | 200 | 200 |
| T5 | peer agent, no override | `false_positive` | 403 | 403, guard at `issue-agent-mutation-ownership-routes.test.ts:1774` |
| T6 | peer, `assigneeAgentId: null` + board user | `false_positive` | 403 | 403, guard at `:1796` |
| T7 | any, **no active recovery action** | gated outcome | **404** | 404, not 403 |
| T8 | 4 outcomes x 4 `sourceIssueStatus` | — | — | no combination trips validation before the authority check; no answer depends on outcome rather than actor |
| T9 | board actor, **no** active action | `false_positive` | 404 | 404, not 403 |
| T10 | override revoked between check and write | any | — | not a TOCTOU on stale authorization |
| T11 | issue has `unresolvedBlockerIssueIds` | any | — | resolving must not silently clear the blocker |
| T12 | the **assignee** | all 4 | — | narrowest legitimate actor, must not be refused their own card |
| T13 | negative control | — | — | re-insert bare `assertBoard(req)`, T2/T3 go red |

T7 and T9 are the same trap from both sides: a board gate placed before the
service lookup answers "you need board access" to "there is nothing to
resolve".

## The change

Gate on authority, not outcome. `requireRecoverySourceMutationAuthority` already
ran and admits the assignee, the recovery owner, and holders of
`tasks:manage_active_checkouts`. Thread its result forward and condition the
board gate on it. This does **not** admit a peer agent — that check still
throws for them.

## Everything else this heartbeat

- **TES-246**: `done`, resolved by measurement.
- **TES-256 root cause fixed**: PR #14152, branch `fix/sibling-write-no-lock-theft`,
  commits `7c619daca` (+ `de06e4a16` for this file). 325/325 green, `tsc`
  byte-identical to baseline, negative control turns 7 tests red.
  A sibling run may now write without taking the live holder's lock.
- PR #14151 was closed by the template bot for a non-compliant description and
  was reopened as #14152 with a compliant body and a branch name that carries no
  internal ticket id. #14152 clears all template checks.

## What the next run should do

Start at RED on T2. Everything above the test list is measured and does not
need redoing.
