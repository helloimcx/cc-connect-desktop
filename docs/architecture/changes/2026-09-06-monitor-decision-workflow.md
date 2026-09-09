# Architecture Change Record: 2026-09-06 Monitor Decision Workflow

## Metadata

- **Date**: 2026-09-06
- **Task**: Issue #112 — Decision workflows for monitor-triggered analysis
- **Architecture Impact**: `Required` (Introduces Grounded Data Contract, Bull/Bear Debate Adjudication, Workspace Decision Log, and Scheduled Retrospective Loop)
- **Active Provider**: Archify (validated via `node .agents/skills/archify/bin/archify.mjs deliver workflow docs/architecture/changes/2026-09-06-monitor-decision-workflow.workflow.json docs/architecture/changes/2026-09-06-monitor-decision-workflow.html --quality showcase`)
- **Status**: Implemented / Verified

## Context & Rationale

Monitor-triggered actions in AgentDock (such as stock quote alerts and inbound webhooks) currently execute as single-prompt turns without data constraints or follow-ups. This change introduces:
1. **Grounded Data Contract**: Constrains the agent to only assert quantitative metrics backed by the verified event snapshot.
2. **Bull/Bear Adversarial Debate**: Directs the agent to argue both sides before rendering an actionable decision with confidence score and invalidation triggers.
3. **Workspace Decision Logging**: Persists decisions into `<workspace>/.agentdock/decisions/<monitor-id>.md`.
4. **Scheduled Retrospective Follow-up**: Automatically schedules a once-off retrospective evaluation job (T+1/T+5) via the scheduler to assess realized outcomes against past assumptions and feed learnings back into future runs.

## Artifacts Generated

- Workflow Spec DSL: `docs/architecture/changes/2026-09-06-monitor-decision-workflow.workflow.json`
- Showcase HTML: `docs/architecture/changes/2026-09-06-monitor-decision-workflow.html` (9/9 checks passed)
- Technical Spec: `docs/specs/2026-09-06-monitor-decision-workflow.md`
- Implementation Plan: `docs/plans/2026-09-06-monitor-decision-workflow.md`
