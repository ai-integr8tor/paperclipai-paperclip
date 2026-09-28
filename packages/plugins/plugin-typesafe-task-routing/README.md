# TypeSafe Task Routing Pilot

Observation-only Paperclip plugin for OCC routing policy `1.0.0`. It subscribes to asynchronous `issue.created`, re-reads the issue, applies hard eligibility rules, and records a plugin-owned recommendation entity. It never mutates issue assignment, status, agent models, or customer-facing data.

## Configuration and disable

The `enabled` instance setting defaults to `false`. Set it to `true` only for the approved pilot. Disable immediately by setting `enabled` back to `false` or disabling/uninstalling the plugin. No data migration or rollback is required; prior recommendation records remain audit evidence.

The SDK reads `TYPESAFE_API_KEY` from the managed runtime environment. Do not put credentials in plugin configuration. The dependency is pinned to `@typesafe-ai/sdk@0.6.0`, and requests are pinned to immutable model `jev-1.13.0`.

## Data handling

Only issue title, description, project id/name, and the approved routing criteria are sent. Audit records include issue id, input revision, policy/question/model versions, raw/effective decision, approved agent mapping, probabilities/confidence, sufficiency probability, latency, and token usage. No credentials, comments, attachments, customer profiles, order records, or payment records are read or sent. Governed-action requests are excluded before evaluation.

## Verification

```sh
pnpm --filter @paperclipai/plugin-typesafe-task-routing test
pnpm --filter @paperclipai/plugin-typesafe-task-routing typecheck
pnpm --filter @paperclipai/plugin-typesafe-task-routing build
```
