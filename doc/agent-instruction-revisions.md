# Canonical agent instruction revisions

Managed entry content has one database history. `agent_instruction_revisions`
stores exact UTF-8 bytes as base64 text (including BOM, CRLF, trailing whitespace,
and NUL), SHA-256, byte length, parent/base revision, restore origin, actor,
responsible user, source run, source, and creation time. `agent_instruction_heads`
selects one revision per company, agent, and relative entry filename. Composite
foreign keys bind heads to their owner's content and agents to their company.
Configuration snapshots in `agent_config_revisions` are not content history.
Migration 0285 adds the tables; existing managed files are seeded lazily on the
first authorized canonical read or commit, without changing their bytes.

The configured `instructionsEntryFile` is authoritative. Legacy managed
`instructionsFilePath` can select a nested filename. A missing configured entry
never causes a scan to select some other AGENTS.md. Supporting bundle files keep
the existing file API; only the configured entry participates in this history.

## Service integration

Import `agentInstructionRevisionService` from
`server/src/services/agent-instruction-revisions.ts` and instantiate it with `db`.
Use the server's authenticated actor, never an actor or responsible-user ID from
request/tool arguments. `AuthorizationActor` is an internal server type.

```ts
const revisions = agentInstructionRevisionService(db);
const target = { companyId, agentId: targetAgentId };
const baseline = await revisions.readCurrent(target, serverActor);
// null means no committed head and no existing managed entry.
// For an existing head, retain its entryFile/id/hash in the server-owned mapping.
const receipt = await revisions.commit({
  ...target,
  entryFile: baseline!.revision.entryFile,
  baseRevisionId: baseline!.revision.id,
  content: collectedBytes, // string or Uint8Array, at most 1 MiB of valid UTF-8
  source: "cleanup",      // board | api | tool | cleanup
}, serverActor);
```

For new entries, obtain the configured entry from `deriveBundleState(agent)` and
pass `baseRevisionId: null`. Do not turn a conflict into a null base or silently
retry with the latest head. `readInstructionBytes(root, entryFile)` from
`agent-instruction-files.ts` validates a specifically registered file; it returns
null for a missing file, rejects symlinks in the path, rejects special files, and
bounds the read itself. The collector must distinguish a missing working file
from a valid empty file and must stop the process before collecting it.

Public operations:

- `readCurrent(target, actor)` returns `AgentInstructionSnapshot | null` and seeds
  existing managed bytes. Reads do not require content-edit permission.
- `commit(input, actor)` returns `AgentInstructionCommitReceipt`.
- `history({ ...target, entryFile, cursor?, limit? }, actor)` returns metadata and
  `nextCursor`; pages are capped at 100 revisions (default 50).
- `readRevision({ ...target, entryFile, revisionId }, actor)` returns exact content.
- `diff({ ...target, entryFile, fromRevisionId, toRevisionId }, actor)` returns both
  snapshots and an exact common-prefix/replacement/common-suffix diff in linear
  time. It does not attempt an automatic merge.
- `restore({ ...target, entryFile, revisionId, baseRevisionId }, actor)` uses the
  same authorization and CAS path. It appends a revision with source `restore`
  and `restoredFromRevisionId`. Identical content is a no-op.
- `materializeCurrent(target)` is an **internal recovery operation**, not an
  authorization API. It copies only the current committed head to the managed
  path while holding the agent lock. Call before launching a run that reads disk
  and after restarting following an interrupted materialization.
- `readCommittedForRuntime(target)` is an internal, company-scoped snapshot read.
  It neither seeds a head nor writes a disk file. Native bundle construction uses
  its exact committed bytes so a pending disk projection cannot load old content.

A transaction locks the target agent, rechecks current authority, inserts a
revision, moves the head, and inserts its activity record. A different current
head yields 409. Identical content returns the existing receipt without another
revision, including retries whose base has advanced to that same content.
Materialization happens after commit under the same serialization lock, always
from the latest head. It uses a temporary file and atomic rename. A later save
cannot be overwritten by an older materializer. A crash or disk error leaves the
database head recoverable. A receipt with `materialization: "pending"` means the
revision is durable and the disk copy still needs repair; it does not mean the
commit failed. GET bundle also attempts that repair and displays a warning if
repair fails. A successful materializer may have copied a newer head than the
receipt if another commit already completed.

`authorizeInstructionCommit(connection, actor, target)` and
`resolveInstructionActor(connection, actor)` are exported from
`agent-instruction-authorization.ts`. The commit service calls them itself;
callers must not treat an earlier authorization result as a reusable grant.
Agent callers must supply the server-bound agent/company plus registered run or
active API key. The service reloads responsible identity, accepted active run
identity context, key scope/revocation, user existence, active company membership,
current target edit permission, and agent restrictions. When capturing a baseline,
retain the server-resolved `onBehalfOfUserId` so identity changes before cleanup
fail closed instead of attributing the candidate to a different user.

Ordinary standard agents inherit their responsible user's existing target
`agents:configure` access for content only. They do not need their own blanket
agent-admin grant. An explicit scoped configure grant or suggest-only grant still
constrains them; suggest-only mutation consumes the existing accepted-change
confirmation inside the commit transaction. Low-trust, task-bridge, and skill-test
containment remains enforced. This path enforces the responsible-user ceiling even
if the general responsible-user policy is configured in shadow mode.

Peer instruction reads require the existing `agent_config:read` grant or the
same strict delegated target content-edit authority. General same-company agent
visibility is insufficient for bundle files, history, diffs, and candidates.
Read checks do not bypass or consume protected-change consent. Self and board
reads retain their existing company visibility rules; external host bundles keep
their instance-admin and configuration-read restrictions.

## HTTP and editor

Existing company-scoped agent URLs now support:

| Operation | Route |
| --- | --- |
| Current entry and revision metadata | `GET /api/agents/:id/instructions-bundle/file?path=...` |
| Content save | `PUT /api/agents/:id/instructions-bundle/file` |
| History | `GET /api/agents/:id/instructions-bundle/history?path=...&cursor=...` |
| Revision content | `GET /api/agents/:id/instructions-bundle/revision/:revisionId?path=...` |
| Diff | `GET /api/agents/:id/instructions-bundle/diff?path=...&from=...&to=...` |
| Restore | `POST /api/agents/:id/instructions-bundle/restore` |
| Preserved edits | `GET /api/agents/:id/instructions-bundle/candidates` |
| Resolve preserved edits | `POST /api/agents/:id/instructions-bundle/candidates/:runId/resolve` |

Entry PUT requires `{ path, content, baseRevisionId }`. Restore requires
`{ path, revisionId, baseRevisionId }`. Content requests reject unknown fields,
including supplied responsible identity. Save/restore return the normal file
detail plus `revision` and `receipt`. The existing editor pins a draft's base,
retains edits on conflicts, shows history and exact revision content/differences,
and restores against the currently displayed head. Save or discard local edits
before restoring. Configuration changes (root, entry selection, legacy prompt
removal) retain the configuration permission gate.

`AgentInstructionSnapshot`, `AgentInstructionRevision`,
`AgentInstructionCommitReceipt`, `AgentInstructionHistory`,
`AgentInstructionDiff`, `AgentInstructionErrorCode`, and
`AgentInstructionErrorDetails` are exported from `@paperclipai/shared`.
Errors use `HttpError` and the existing HTTP error envelope. A conflict may
return a null `currentRevisionId` when the existing disk file has not yet been
seeded; read the current entry to obtain its durable initial revision:

| Status | Detail code / action |
| --- | --- |
| 409 | `INSTRUCTION_REVISION_CONFLICT`: preserve candidate, read current head, explicitly resolve |
| 409 | `INSTRUCTION_ENTRY_CHANGED`: configured entry changed; do not collect into the replacement entry |
| 403 | `INSTRUCTION_IDENTITY_INVALID`, `RESPONSIBLE_USER_UNAVAILABLE`, `RESPONSIBLE_USER_UNAUTHORIZED`, or existing authorization/consent denial |
| 422 | `INSTRUCTION_BASE_REQUIRED`: read first and provide the base |
| 422 | `INSTRUCTION_CONTENT_INVALID`, `INSTRUCTION_PATH_INVALID`: reject candidate; preserve canonical bytes |
| 422 | `INSTRUCTION_MANAGED_BUNDLE_REQUIRED`: instance administrator must explicitly migrate the external bundle |
| 422 | `INSTRUCTION_REVISION_REQUIRED`: use canonical content commit instead of filesystem overwrite |
| 404 | Target or revision is absent from the requested owner scope |

External host bundles are never automatically seeded or written by this service.
Their existing instance-admin read/configuration restrictions remain. Managed
bootstrap/import/reset helpers now refuse to overwrite an existing entry with
different content or any entry with revision history. Apply content changes through
the canonical commit path; provisioning a new entry remains supported. These
helpers do not provide an alternate content-history bypass. Supporting-file writes
reload configuration under the same agent lock and refuse current or historical
versioned entries, including when a route has a stale configuration snapshot.
Board stock resets
for built-in agents pass the authenticated actor through the same commit service.
Automatic reconciliation preserves existing stock content when no responsible
operator is present; the available update remains visible for an authorized reset.
Generic import and plugin reset callers must use the canonical writer to replace
existing versioned content; their filesystem initialization helper fails closed.
The managed plugin reset path uses a host-bound plugin principal, not a synthetic
board actor. Under the agent lock it validates the installed `agents.managed`
capability, declared agent key, company/resource binding, and ownership marker.
Reset checks both the observed configured entry and the declared entry's head,
preserves previous entry history, and records the plugin as its audit actor.

## Runtime handoff boundary

`agentInstructionWorkingCopyService` provides the registered-copy lifecycle.
Migration 0286 stores each run's configured entry, original revision/hash,
server-bound responsible user, private local/execution roots, captured candidate,
attempt count, diagnostics, and save receipt. Preparation handles managed bundles
with an existing entry only; external bundles are never imported. Collection
reads only the registered entry, accepts normal atomic editor replacement, rejects
symlinks/special files, and bounds valid UTF-8 to 1 MiB. Missing and empty files are
distinct. A captured candidate is durable before authorization/CAS; duplicate
callbacks and restarts can retry bytes without launching a provider. Failed
permission/CAS saves preserve candidates, and public diagnostics omit filesystem
paths. Explicit saves advance the baseline only when the registered copy currently
matches the committed content; unrelated edits retain the original conflict fence.
For a same-run retry, a verified stopped copy can refresh from the current head
only when its bytes are already accounted for by the completed receipt or current
canonical entry. Staging must succeed before the previous receipt and stop evidence
are cleared. An interrupted refresh retains that completed record. Uncollected
private edits keep their old base. An unchanged warm turn retains its live provider
owner, so an external edit does not silently rebase or rewrite that private copy.

The native runner exposes a stopped-session observer only after its required
owned close joins successfully. A terminal-turn change probe can retire the exact
warm owner through the existing checkpoint/close path before collecting; unchanged
warm sessions stay reusable. The optional working-copy context is separate from
the immutable instruction bundle and its prompt digest.

Heartbeat prepares the copy under the selected workspace's private
`.paperclip-runtime/instruction-edits-<run>/instructions` directory, publishes its
exact configured entry path to the provider, and collects it before workspace
restoration or environment disposal. Git's local exclude file excludes the runtime
directory from ordinary staging; workspace snapshots already exclude that directory.
The run-to-workspace/environment binding cannot change during a same-run retry.
Cloud API providers without access to the selected filesystem use the versioned
instruction tools; they are not given an inaccessible editable file.

Native execution waits for owned session close, or closes only a changed warm
owner through the existing checkpoint path. Unchanged warm sessions keep their
provider process and sandbox lease. Legacy CLI adapters collect after the final
invocation's confirmed process exit; ACP waits for confirmed runtime close. A
remote timeout, disconnect, or failed close is not stop evidence. The run log and
result include the save receipt or diagnostic; no missing or unverified bytes are
reported as saved.

Recovery retries captured bytes without launching a model. An uncaptured local
copy requires a durable stopped-process receipt; a later launch invalidates older
stop evidence. Unconfirmed stops remain visible as pending collection. Lost remote
environments produce explicit unavailable diagnostics, without restarting the
provider to retrieve files. Conflicts, permission failures, and unavailable copies
remain inspectable in the instruction editor. Real provider and Daytona proofs
are recorded with the Product E2E instruction-persistence workflow; unit/service
tests alone do not establish runtime parity.

## Dedicated native tools

Ordinary native runs expose `read_agent_instructions`,
`update_agent_instructions`, `get_agent_instruction_history`, and
`restore_agent_instructions` by default. `targetAgentId` is optional and defaults
to the calling agent; another target must be in the same company. Read and
history are available in all task modes. Update and restore are available in
standard and planning modes, subject to the canonical service's current
responsible-user permissions, containment, and consent requirements.

Read returns the configured `entryFile`, exact content, and current revision.
Retain that entry filename and revision ID when preparing an update. Both writes
require an explicit `baseRevisionId`; only update accepts null for a genuinely
new entry. Restore requires the existing current revision ID.
Historical reads take both `entryFile` and `revisionId`. History pages contain at
most 100 entries and include a continuation cursor. Restore appends a new
revision; it does not delete history. Tool JSON cannot supply company, caller,
run, responsible user, or source attribution. The native authority binds those
values from the active run, and the canonical service reloads authorization.

A tool commit is immediately durable. If a run-local working copy still contains
older content, cleanup must preserve its conflict candidate rather than replace
the newer tool commit. A 409 response requires explicit conflict resolution;
never silently retry an old candidate against the latest revision.

The instructions editor lists preserved run edits, including conflicts and
unavailable collection results. Review loads the preserved bytes into an editable
draft and pins the current canonical revision. Saving resolves that candidate
through the same permission and CAS checks. Conflicts retain both the draft and
its original base. Candidate API responses contain content and diagnostic metadata;
server and sandbox filesystem roots remain private. Resolve requests accept only
`content` and `baseRevisionId`; the registered candidate supplies its entry file.
If the configured entry changed, the editor offers a read-only view and exact copy
of the old candidate. It cannot implicitly save those bytes into the new entry.
The operator can explicitly edit the current entry and paste the recovered text.
