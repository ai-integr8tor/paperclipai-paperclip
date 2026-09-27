<!-- GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory. -->

# Capability Capability Contract

This generated contract is a self-contained derivative of the Paperclip skill, its seven references, the Paperclip Evals corpus, and the legacy MCP tool surface. It does not import or contact the Paperclip control plane.

The skill/reference inventory and eval cases are the only normative behavior sources. Paperclip does not use the legacy MCP calls as a production capability surface; all MCP names below are traceability aliases folded into normative eval rows. Their disposition, grants, assertions, and evidence contract are inherited from the target row rather than classified independently.

## Baseline Counts

- Skill/reference headings: 156
- Eval cases: 106 across 16 groups
- Total normative rows: 262
- Legacy MCP aliases folded into normative rows: 42

| Eval group | Cases |
| --- | ---: |
| hb | 5 |
| co | 6 |
| st | 8 |
| cm | 6 |
| se | 4 |
| su | 4 |
| bl | 5 |
| dp | 3 |
| ix | 9 |
| ap | 6 |
| ar | 4 |
| er | 9 |
| rf | 22 |
| mh | 4 |
| rs | 3 |
| wk | 8 |

## Regeneration

- `pnpm --dir packages/paperclip-runner generate:capability-inventory` imports the canonical baselines and rewrites every generated file.
- `pnpm --dir packages/paperclip-runner check:capability-inventory` validates counts, uniqueness, normative dispositions, one-to-one MCP folds, required fields, and generated-file drift without requiring the external eval repository.

## Skill / Reference Rows

| Capability | Primary disposition | Source anchor |
| --- | --- | --- |
| skill:skills/paperclip/SKILL.md:paperclip-skill:10 | optional_agent_tool | skills/paperclip/SKILL.md:10 |
| skill:skills/paperclip/SKILL.md:terminology:14 | optional_agent_tool | skills/paperclip/SKILL.md:14 |
| skill:skills/paperclip/SKILL.md:authentication:18 | control_plane_owned | skills/paperclip/SKILL.md:18 |
| skill:skills/paperclip/SKILL.md:conversation-tasks:30 | optional_agent_tool | skills/paperclip/SKILL.md:30 |
| skill:skills/paperclip/SKILL.md:server-verified-external-chat-turns:47 | control_plane_owned | skills/paperclip/SKILL.md:47 |
| skill:skills/paperclip/SKILL.md:the-heartbeat-procedure:87 | optional_agent_tool | skills/paperclip/SKILL.md:87 |
| skill:skills/paperclip/SKILL.md:generated-artifacts-and-work-products:159 | always_agent_tool | skills/paperclip/SKILL.md:159 |
| skill:skills/paperclip/SKILL.md:status-quick-guide:207 | control_plane_owned | skills/paperclip/SKILL.md:207 |
| skill:skills/paperclip/SKILL.md:monitors-and-watchers-say-only-what-you-actually-scheduled:217 | optional_agent_tool | skills/paperclip/SKILL.md:217 |
| skill:skills/paperclip/SKILL.md:delegating-review-tasks:230 | always_agent_tool | skills/paperclip/SKILL.md:230 |
| skill:skills/paperclip/SKILL.md:managing-a-user-s-inbox:241 | control_plane_owned | skills/paperclip/SKILL.md:241 |
| skill:skills/paperclip/SKILL.md:issue-dependencies-blockers:249 | control_plane_owned | skills/paperclip/SKILL.md:249 |
| skill:skills/paperclip/SKILL.md:requesting-board-approval:274 | optional_agent_tool | skills/paperclip/SKILL.md:274 |
| skill:skills/paperclip/SKILL.md:issue-thread-interactions:302 | optional_agent_tool | skills/paperclip/SKILL.md:302 |
| skill:skills/paperclip/SKILL.md:decision-briefs:331 | optional_agent_tool | skills/paperclip/SKILL.md:331 |
| skill:skills/paperclip/SKILL.md:standalone-decisions:355 | optional_agent_tool | skills/paperclip/SKILL.md:355 |
| skill:skills/paperclip/SKILL.md:mcp-tool-approval-gates:487 | optional_agent_tool | skills/paperclip/SKILL.md:487 |
| skill:skills/paperclip/SKILL.md:niche-workflow-pointers:529 | optional_agent_tool | skills/paperclip/SKILL.md:529 |
| skill:skills/paperclip/SKILL.md:cases:539 | optional_agent_tool | skills/paperclip/SKILL.md:539 |
| skill:skills/paperclip/SKILL.md:company-skills-workflow:544 | optional_agent_tool | skills/paperclip/SKILL.md:544 |
| skill:skills/paperclip/SKILL.md:routines:555 | optional_agent_tool | skills/paperclip/SKILL.md:555 |
| skill:skills/paperclip/SKILL.md:issue-workspace-runtime-controls:566 | optional_agent_tool | skills/paperclip/SKILL.md:566 |
| skill:skills/paperclip/SKILL.md:proposing-credentials-safely:573 | optional_agent_tool | skills/paperclip/SKILL.md:573 |
| skill:skills/paperclip/SKILL.md:reading-granted-secrets:580 | optional_agent_tool | skills/paperclip/SKILL.md:580 |
| skill:skills/paperclip/SKILL.md:critical-rules:606 | optional_agent_tool | skills/paperclip/SKILL.md:606 |
| skill:skills/paperclip/SKILL.md:comment-style-required:630 | always_agent_tool | skills/paperclip/SKILL.md:630 |
| skill:skills/paperclip/SKILL.md:update:662 | optional_agent_tool | skills/paperclip/SKILL.md:662 |
| skill:skills/paperclip/SKILL.md:planning-required-when-planning-requested:672 | optional_agent_tool | skills/paperclip/SKILL.md:672 |
| skill:skills/paperclip/SKILL.md:key-endpoints-hot-routes:705 | optional_agent_tool | skills/paperclip/SKILL.md:705 |
| skill:skills/paperclip/SKILL.md:searching-issues:734 | optional_agent_tool | skills/paperclip/SKILL.md:734 |
| skill:skills/paperclip/SKILL.md:full-reference:744 | optional_agent_tool | skills/paperclip/SKILL.md:744 |
| skill:skills/paperclip/references/artifacts.md:generated-artifacts-and-work-products:1 | always_agent_tool | skills/paperclip/references/artifacts.md:1 |
| skill:skills/paperclip/references/artifacts.md:workspace-only-file-references:15 | optional_agent_tool | skills/paperclip/references/artifacts.md:15 |
| skill:skills/paperclip/references/cases.md:cases:1 | optional_agent_tool | skills/paperclip/references/cases.md:1 |
| skill:skills/paperclip/references/cases.md:core-model:12 | optional_agent_tool | skills/paperclip/references/cases.md:12 |
| skill:skills/paperclip/references/cases.md:upsert-semantics:29 | optional_agent_tool | skills/paperclip/references/cases.md:29 |
| skill:skills/paperclip/references/cases.md:read-and-search:67 | optional_agent_tool | skills/paperclip/references/cases.md:67 |
| skill:skills/paperclip/references/cases.md:documents:90 | always_agent_tool | skills/paperclip/references/cases.md:90 |
| skill:skills/paperclip/references/cases.md:fields:118 | optional_agent_tool | skills/paperclip/references/cases.md:118 |
| skill:skills/paperclip/references/cases.md:issue-links:151 | optional_agent_tool | skills/paperclip/references/cases.md:151 |
| skill:skills/paperclip/references/cases.md:child-cases:176 | optional_agent_tool | skills/paperclip/references/cases.md:176 |
| skill:skills/paperclip/references/cases.md:attachments:195 | optional_agent_tool | skills/paperclip/references/cases.md:195 |
| skill:skills/paperclip/references/cases.md:lifecycle:208 | optional_agent_tool | skills/paperclip/references/cases.md:208 |
| skill:skills/paperclip/references/cases.md:worked-blog-post-example:222 | optional_agent_tool | skills/paperclip/references/cases.md:222 |
| skill:skills/paperclip/references/company-skills.md:company-skills-workflow:1 | optional_agent_tool | skills/paperclip/references/company-skills.md:1 |
| skill:skills/paperclip/references/company-skills.md:what-exists:5 | optional_agent_tool | skills/paperclip/references/company-skills.md:5 |
| skill:skills/paperclip/references/company-skills.md:permission-model:22 | optional_agent_tool | skills/paperclip/references/company-skills.md:22 |
| skill:skills/paperclip/references/company-skills.md:core-endpoints:29 | optional_agent_tool | skills/paperclip/references/company-skills.md:29 |
| skill:skills/paperclip/references/company-skills.md:install-a-skill-into-the-company:65 | optional_agent_tool | skills/paperclip/references/company-skills.md:65 |
| skill:skills/paperclip/references/company-skills.md:app-shipped-catalog:75 | optional_agent_tool | skills/paperclip/references/company-skills.md:75 |
| skill:skills/paperclip/references/company-skills.md:external-source-import:101 | optional_agent_tool | skills/paperclip/references/company-skills.md:101 |
| skill:skills/paperclip/references/company-skills.md:source-types-in-order-of-preference:105 | optional_agent_tool | skills/paperclip/references/company-skills.md:105 |
| skill:skills/paperclip/references/company-skills.md:example-skills-sh-import-preferred:116 | optional_agent_tool | skills/paperclip/references/company-skills.md:116 |
| skill:skills/paperclip/references/company-skills.md:example-github-import:138 | optional_agent_tool | skills/paperclip/references/company-skills.md:138 |
| skill:skills/paperclip/references/company-skills.md:inspect-what-was-installed:164 | optional_agent_tool | skills/paperclip/references/company-skills.md:164 |
| skill:skills/paperclip/references/company-skills.md:assign-skills-to-an-existing-agent:181 | optional_agent_tool | skills/paperclip/references/company-skills.md:181 |
| skill:skills/paperclip/references/company-skills.md:include-skills-during-hire-or-create:216 | optional_agent_tool | skills/paperclip/references/company-skills.md:216 |
| skill:skills/paperclip/references/company-skills.md:notes:256 | optional_agent_tool | skills/paperclip/references/company-skills.md:256 |
| skill:skills/paperclip/references/issue-workspaces.md:issue-workspace-runtime-controls:1 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:1 |
| skill:skills/paperclip/references/issue-workspaces.md:discover-the-workspace:5 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:5 |
| skill:skills/paperclip/references/issue-workspaces.md:control-services:23 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:23 |
| skill:skills/paperclip/references/issue-workspaces.md:start-all-configured-services-waits-for-configured-readiness-checks:28 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:28 |
| skill:skills/paperclip/references/issue-workspaces.md:restart-all-configured-services:36 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:36 |
| skill:skills/paperclip/references/issue-workspaces.md:stop-all-running-services:44 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:44 |
| skill:skills/paperclip/references/issue-workspaces.md:read-the-url:63 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:63 |
| skill:skills/paperclip/references/issue-workspaces.md:mcp-tools:72 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:72 |
| skill:skills/paperclip/references/routines.md:paperclip-routines:1 | optional_agent_tool | skills/paperclip/references/routines.md:1 |
| skill:skills/paperclip/references/routines.md:lifecycle:16 | optional_agent_tool | skills/paperclip/references/routines.md:16 |
| skill:skills/paperclip/references/routines.md:creating-a-routine:27 | optional_agent_tool | skills/paperclip/references/routines.md:27 |
| skill:skills/paperclip/references/routines.md:concurrency-policies:64 | optional_agent_tool | skills/paperclip/references/routines.md:64 |
| skill:skills/paperclip/references/routines.md:catch-up-policies:76 | optional_agent_tool | skills/paperclip/references/routines.md:76 |
| skill:skills/paperclip/references/routines.md:activity-gated-scheduled-runs:87 | optional_agent_tool | skills/paperclip/references/routines.md:87 |
| skill:skills/paperclip/references/routines.md:example-skip-quiet-nights:107 | optional_agent_tool | skills/paperclip/references/routines.md:107 |
| skill:skills/paperclip/references/routines.md:adding-triggers:126 | optional_agent_tool | skills/paperclip/references/routines.md:126 |
| skill:skills/paperclip/references/routines.md:schedule-cron:136 | optional_agent_tool | skills/paperclip/references/routines.md:136 |
| skill:skills/paperclip/references/routines.md:webhook:150 | optional_agent_tool | skills/paperclip/references/routines.md:150 |
| skill:skills/paperclip/references/routines.md:api-manual-only:167 | optional_agent_tool | skills/paperclip/references/routines.md:167 |
| skill:skills/paperclip/references/routines.md:updating-and-deleting-triggers:179 | optional_agent_tool | skills/paperclip/references/routines.md:179 |
| skill:skills/paperclip/references/routines.md:manual-run:196 | optional_agent_tool | skills/paperclip/references/routines.md:196 |
| skill:skills/paperclip/references/routines.md:updating-a-routine:212 | optional_agent_tool | skills/paperclip/references/routines.md:212 |
| skill:skills/paperclip/references/routines.md:reading-routines-and-runs:223 | optional_agent_tool | skills/paperclip/references/routines.md:223 |
| skill:skills/paperclip/references/workflows.md:paperclip-workflow-playbooks:1 | optional_agent_tool | skills/paperclip/references/workflows.md:1 |
| skill:skills/paperclip/references/workflows.md:project-setup-ceo-manager:7 | optional_agent_tool | skills/paperclip/references/workflows.md:7 |
| skill:skills/paperclip/references/workflows.md:openclaw-invite-ceo:22 | optional_agent_tool | skills/paperclip/references/workflows.md:22 |
| skill:skills/paperclip/references/workflows.md:setting-agent-instructions-path:50 | optional_agent_tool | skills/paperclip/references/workflows.md:50 |
| skill:skills/paperclip/references/workflows.md:company-import-export:79 | optional_agent_tool | skills/paperclip/references/workflows.md:79 |
| skill:skills/paperclip/references/workflows.md:self-test-playbook-app-level:106 | optional_agent_tool | skills/paperclip/references/workflows.md:106 |
| skill:skills/paperclip/references/api-reference.md:paperclip-api-reference:1 | optional_agent_tool | skills/paperclip/references/api-reference.md:1 |
| skill:skills/paperclip/references/api-reference.md:response-schemas:9 | optional_agent_tool | skills/paperclip/references/api-reference.md:9 |
| skill:skills/paperclip/references/api-reference.md:agent-record-get-api-agents-me-or-get-api-agents-agentid:11 | optional_agent_tool | skills/paperclip/references/api-reference.md:11 |
| skill:skills/paperclip/references/api-reference.md:company-portability:44 | optional_agent_tool | skills/paperclip/references/api-reference.md:44 |
| skill:skills/paperclip/references/api-reference.md:issue-with-ancestors-get-api-issues-issueid:110 | optional_agent_tool | skills/paperclip/references/api-reference.md:110 |
| skill:skills/paperclip/references/api-reference.md:issue-update-response-patch-api-issues-issueid:199 | optional_agent_tool | skills/paperclip/references/api-reference.md:199 |
| skill:skills/paperclip/references/api-reference.md:blocker-diagnostics-get-api-issues-issueid-diagnostics-blockers:241 | control_plane_owned | skills/paperclip/references/api-reference.md:241 |
| skill:skills/paperclip/references/api-reference.md:wake-diagnostics-get-api-issues-issueid-diagnostics-wakes:280 | control_plane_owned | skills/paperclip/references/api-reference.md:280 |
| skill:skills/paperclip/references/api-reference.md:subtree-diagnostics-get-api-issues-issueid-diagnostics-subtree:324 | optional_agent_tool | skills/paperclip/references/api-reference.md:324 |
| skill:skills/paperclip/references/api-reference.md:execution-policy-fields-on-an-issue:372 | optional_agent_tool | skills/paperclip/references/api-reference.md:372 |
| skill:skills/paperclip/references/api-reference.md:cross-agent-review-gates:424 | always_agent_tool | skills/paperclip/references/api-reference.md:424 |
| skill:skills/paperclip/references/api-reference.md:worked-example-ic-heartbeat:457 | optional_agent_tool | skills/paperclip/references/api-reference.md:457 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:462 | control_plane_owned | skills/paperclip/references/api-reference.md:462 |
| skill:skills/paperclip/references/api-reference.md:2-check-inbox:466 | control_plane_owned | skills/paperclip/references/api-reference.md:466 |
| skill:skills/paperclip/references/api-reference.md:3-already-have-issue-101-inprogress-highest-priority-continue-it:473 | optional_agent_tool | skills/paperclip/references/api-reference.md:473 |
| skill:skills/paperclip/references/api-reference.md:4-do-the-actual-work-write-code-run-tests:480 | optional_agent_tool | skills/paperclip/references/api-reference.md:480 |
| skill:skills/paperclip/references/api-reference.md:5-work-is-done-update-status-and-comment-in-one-call:482 | always_agent_tool | skills/paperclip/references/api-reference.md:482 |
| skill:skills/paperclip/references/api-reference.md:6-still-have-time-checkout-the-next-task:486 | control_plane_owned | skills/paperclip/references/api-reference.md:486 |
| skill:skills/paperclip/references/api-reference.md:7-made-partial-progress-not-done-yet-comment-and-exit:493 | always_agent_tool | skills/paperclip/references/api-reference.md:493 |
| skill:skills/paperclip/references/api-reference.md:worked-example-report-a-board-user-s-mine-inbox:498 | control_plane_owned | skills/paperclip/references/api-reference.md:498 |
| skill:skills/paperclip/references/api-reference.md:board-user-created-the-requesting-issue:503 | optional_agent_tool | skills/paperclip/references/api-reference.md:503 |
| skill:skills/paperclip/references/api-reference.md:fetch-the-board-user-s-mine-inbox-issues:507 | control_plane_owned | skills/paperclip/references/api-reference.md:507 |
| skill:skills/paperclip/references/api-reference.md:summarize-it-back-to-the-board-in-a-comment-or-document:521 | always_agent_tool | skills/paperclip/references/api-reference.md:521 |
| skill:skills/paperclip/references/api-reference.md:worked-example-archive-a-resolved-inbox-item:526 | control_plane_owned | skills/paperclip/references/api-reference.md:526 |
| skill:skills/paperclip/references/api-reference.md:the-responsible-user-s-id-is-resolved-from-the-authenticated-agent-run:531 | optional_agent_tool | skills/paperclip/references/api-reference.md:531 |
| skill:skills/paperclip/references/api-reference.md:reverse-the-archive-if-it-was-premature-or-no-longer-desired:540 | optional_agent_tool | skills/paperclip/references/api-reference.md:540 |
| skill:skills/paperclip/references/api-reference.md:worked-example-reviewer-approver-heartbeat:550 | always_agent_tool | skills/paperclip/references/api-reference.md:550 |
| skill:skills/paperclip/references/api-reference.md:worked-example-manager-heartbeat:589 | optional_agent_tool | skills/paperclip/references/api-reference.md:589 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:592 | control_plane_owned | skills/paperclip/references/api-reference.md:592 |
| skill:skills/paperclip/references/api-reference.md:2-check-team-status:596 | optional_agent_tool | skills/paperclip/references/api-reference.md:596 |
| skill:skills/paperclip/references/api-reference.md:3-agent-42-is-blocked-read-comments:603 | control_plane_owned | skills/paperclip/references/api-reference.md:603 |
| skill:skills/paperclip/references/api-reference.md:4-unblock-reassign-and-comment:607 | control_plane_owned | skills/paperclip/references/api-reference.md:607 |
| skill:skills/paperclip/references/api-reference.md:5-check-own-assignments:611 | optional_agent_tool | skills/paperclip/references/api-reference.md:611 |
| skill:skills/paperclip/references/api-reference.md:6-create-subtasks-and-delegate:618 | optional_agent_tool | skills/paperclip/references/api-reference.md:618 |
| skill:skills/paperclip/references/api-reference.md:load-tests-depend-on-caching-layer-being-done-first-paperclip-will-auto-wake-agent-55-when-the-blocker-resolves:624 | control_plane_owned | skills/paperclip/references/api-reference.md:624 |
| skill:skills/paperclip/references/api-reference.md:7-dashboard-for-health-check:629 | optional_agent_tool | skills/paperclip/references/api-reference.md:629 |
| skill:skills/paperclip/references/api-reference.md:comments-and-mentions:635 | always_agent_tool | skills/paperclip/references/api-reference.md:635 |
| skill:skills/paperclip/references/api-reference.md:update:642 | optional_agent_tool | skills/paperclip/references/api-reference.md:642 |
| skill:skills/paperclip/references/api-reference.md:cross-team-work-and-delegation:680 | optional_agent_tool | skills/paperclip/references/api-reference.md:680 |
| skill:skills/paperclip/references/api-reference.md:receiving-cross-team-work:684 | optional_agent_tool | skills/paperclip/references/api-reference.md:684 |
| skill:skills/paperclip/references/api-reference.md:escalation:694 | optional_agent_tool | skills/paperclip/references/api-reference.md:694 |
| skill:skills/paperclip/references/api-reference.md:company-context:704 | optional_agent_tool | skills/paperclip/references/api-reference.md:704 |
| skill:skills/paperclip/references/api-reference.md:company-branding-ceo-board:716 | optional_agent_tool | skills/paperclip/references/api-reference.md:716 |
| skill:skills/paperclip/references/api-reference.md:openclaw-invite-prompt-ceo:736 | optional_agent_tool | skills/paperclip/references/api-reference.md:736 |
| skill:skills/paperclip/references/api-reference.md:setting-agent-instructions-path:755 | optional_agent_tool | skills/paperclip/references/api-reference.md:755 |
| skill:skills/paperclip/references/api-reference.md:project-setup-create-workspace:788 | optional_agent_tool | skills/paperclip/references/api-reference.md:788 |
| skill:skills/paperclip/references/api-reference.md:option-a-one-call-create-with-workspace:812 | optional_agent_tool | skills/paperclip/references/api-reference.md:812 |
| skill:skills/paperclip/references/api-reference.md:option-b-two-calls-project-first-then-workspace:831 | optional_agent_tool | skills/paperclip/references/api-reference.md:831 |
| skill:skills/paperclip/references/api-reference.md:governance-and-approvals:860 | optional_agent_tool | skills/paperclip/references/api-reference.md:860 |
| skill:skills/paperclip/references/api-reference.md:requesting-a-hire-management-only:866 | optional_agent_tool | skills/paperclip/references/api-reference.md:866 |
| skill:skills/paperclip/references/api-reference.md:ceo-strategy-approval:931 | optional_agent_tool | skills/paperclip/references/api-reference.md:931 |
| skill:skills/paperclip/references/api-reference.md:questions-and-waiting-for-human-input:940 | always_agent_tool | skills/paperclip/references/api-reference.md:940 |
| skill:skills/paperclip/references/api-reference.md:issue-thread-confirmations:1037 | always_agent_tool | skills/paperclip/references/api-reference.md:1037 |
| skill:skills/paperclip/references/api-reference.md:checkbox-confirmations:1095 | always_agent_tool | skills/paperclip/references/api-reference.md:1095 |
| skill:skills/paperclip/references/api-reference.md:item-verdict-requests:1210 | optional_agent_tool | skills/paperclip/references/api-reference.md:1210 |
| skill:skills/paperclip/references/api-reference.md:checking-approval-status:1320 | optional_agent_tool | skills/paperclip/references/api-reference.md:1320 |
| skill:skills/paperclip/references/api-reference.md:approval-follow-up-requesting-agent:1326 | always_agent_tool | skills/paperclip/references/api-reference.md:1326 |
| skill:skills/paperclip/references/api-reference.md:issue-lifecycle:1344 | always_agent_tool | skills/paperclip/references/api-reference.md:1344 |
| skill:skills/paperclip/references/api-reference.md:error-handling:1374 | control_plane_owned | skills/paperclip/references/api-reference.md:1374 |
| skill:skills/paperclip/references/api-reference.md:full-api-reference:1388 | optional_agent_tool | skills/paperclip/references/api-reference.md:1388 |
| skill:skills/paperclip/references/api-reference.md:agents:1390 | optional_agent_tool | skills/paperclip/references/api-reference.md:1390 |
| skill:skills/paperclip/references/api-reference.md:issues-tasks:1411 | optional_agent_tool | skills/paperclip/references/api-reference.md:1411 |
| skill:skills/paperclip/references/api-reference.md:companies-projects-goals:1451 | optional_agent_tool | skills/paperclip/references/api-reference.md:1451 |
| skill:skills/paperclip/references/api-reference.md:routines:1475 | optional_agent_tool | skills/paperclip/references/api-reference.md:1475 |
| skill:skills/paperclip/references/api-reference.md:approvals-costs-activity-dashboard:1491 | optional_agent_tool | skills/paperclip/references/api-reference.md:1491 |
| skill:skills/paperclip/references/api-reference.md:secrets:1513 | optional_agent_tool | skills/paperclip/references/api-reference.md:1513 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-proposals:1526 | optional_agent_tool | skills/paperclip/references/api-reference.md:1526 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-access:1626 | optional_agent_tool | skills/paperclip/references/api-reference.md:1626 |
| skill:skills/paperclip/references/api-reference.md:common-mistakes:1666 | optional_agent_tool | skills/paperclip/references/api-reference.md:1666 |

## Legacy MCP Alias Index

This is a compatibility/traceability index, not a tool catalog. “Inherited disposition” is shown only to make the normative target easy to audit.

| Legacy MCP name | Folded into normative row | Inherited disposition | Source anchor |
| --- | --- | --- | --- |
| paperclipMe | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:295 |
| paperclipInboxLite | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:301 |
| paperclipListAgents | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:307 |
| paperclipListSkills | eval:rf-cskill-audit-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:313 |
| paperclipGetAgent | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:319 |
| paperclipListIssues | eval:se-q-filters-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:328 |
| paperclipGetIssue | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:343 |
| paperclipGetHeartbeatContext | eval:hb-context-01 | control_plane_owned | packages/mcp-server/src/tools.ts:349 |
| paperclipListComments | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:358 |
| paperclipGetComment | eval:hb-wake-comment-01 | control_plane_owned | packages/mcp-server/src/tools.ts:371 |
| paperclipListIssueApprovals | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:378 |
| paperclipListDocuments | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:384 |
| paperclipGetDocument | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:390 |
| paperclipListDocumentRevisions | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:397 |
| paperclipListProjects | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:407 |
| paperclipGetProject | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:413 |
| paperclipGetIssueWorkspaceRuntime | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:422 |
| paperclipControlIssueWorkspaceServices | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:428 |
| paperclipWaitForIssueWorkspaceService | eval:rf-iws-target-restart-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:445 |
| paperclipListGoals | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:471 |
| paperclipGetGoal | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:477 |
| paperclipListApprovals | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:483 |
| paperclipCreateApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:492 |
| paperclipGetApproval | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:501 |
| paperclipGetApprovalIssues | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:507 |
| paperclipListApprovalComments | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:513 |
| paperclipCreateIssue | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:519 |
| paperclipUpdateIssue | eval:st-done-comment-01 | always_agent_tool | packages/mcp-server/src/tools.ts:526 |
| paperclipCheckoutIssue | eval:co-body-contract-01 | control_plane_owned | packages/mcp-server/src/tools.ts:533 |
| paperclipReleaseIssue | eval:er-release-01 | control_plane_owned | packages/mcp-server/src/tools.ts:545 |
| paperclipAddComment | eval:cm-multiline-01 | always_agent_tool | packages/mcp-server/src/tools.ts:551 |
| paperclipSuggestTasks | eval:ix-suggest-tasks-01 | always_agent_tool | packages/mcp-server/src/tools.ts:558 |
| paperclipAskUserQuestions | eval:ix-questions-01 | always_agent_tool | packages/mcp-server/src/tools.ts:570 |
| paperclipRequestConfirmation | eval:ix-confirmation-plan-01 | always_agent_tool | packages/mcp-server/src/tools.ts:582 |
| paperclipRequestCheckboxConfirmation | eval:ix-checkbox-01 | always_agent_tool | packages/mcp-server/src/tools.ts:594 |
| paperclipUpsertIssueDocument | eval:dp-plan-doc-01 | always_agent_tool | packages/mcp-server/src/tools.ts:606 |
| paperclipRestoreIssueDocumentRevision | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:617 |
| paperclipLinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:632 |
| paperclipUnlinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:641 |
| paperclipApprovalDecision | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:651 |
| paperclipAddApprovalComment | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:673 |
| paperclipApiRequest | eval:rf-api-404-report-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:682 |
