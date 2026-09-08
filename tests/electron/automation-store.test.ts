import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AutomationCreateInput } from '../../packages/contracts/src/automations.js';
import { LocalCoreAcpStore } from '../../services/local-ai-core/src/acp/local-core-acp-store.js';
import { LocalAutomationStore } from '../../services/local-ai-core/src/acp/store/automation-store.js';

function createInput(overrides: Partial<AutomationCreateInput> = {}): AutomationCreateInput {
  return {
    workspaceId: 'workspace-1',
    title: 'Check service health',
    enabled: true,
    activation: { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
    condition: { kind: 'expression', expression: 'status == "ok"' },
    action: { kind: 'agent-prompt', promptTemplate: 'Investigate {{status}}', executionMode: 'side-thread' },
    delivery: { platform: 'local', route: { type: 'local.thread', channelId: 'workspace-1' } },
    policies: { concurrency: 'skip-if-running', cooldownMs: 1_000 },
    ...overrides,
  };
}

function fixture() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'automation-store-'));
  const facade = new LocalCoreAcpStore(userDataPath);
  const db = (facade as unknown as { db: ConstructorParameters<typeof LocalAutomationStore>[0] }).db;
  const store = new LocalAutomationStore(db);
  return {
    facade,
    store,
    db,
    close() {
      facade.close();
      rmSync(userDataPath, { recursive: true, force: true });
    },
  };
}

test('creates, reads, updates, and persists trusted automation state', () => {
  const context = fixture();
  try {
    const created = context.store.create(createInput());
    assert.equal(context.store.get(created.id)?.title, 'Check service health');
    assert.equal(context.store.list('workspace-1').length, 1);
    assert.equal(context.store.list('other-workspace').length, 0);

    const updated = context.store.update(created.id, { title: 'Check API health', enabled: false });
    assert.equal(updated.title, 'Check API health');
    assert.equal(updated.enabled, false);

    const state = context.store.updateState(created.id, {
      health: 'blocked',
      blockedReason: 'Approved script was revoked',
      lastSuccessfulMatch: false,
      lastEvaluationAt: '2026-07-05T01:00:00.000Z',
      consecutiveEvaluationFailures: 2,
      nextCheckAt: '2026-07-05T01:05:00.000Z',
    });
    assert.equal(state.health, 'blocked');
    assert.equal(state.blockedReason, 'Approved script was revoked');
    assert.equal(state.lastSuccessfulMatch, false);
    assert.equal(state.consecutiveEvaluationFailures, 2);

    const row = context.db.prepare('SELECT next_check_at FROM automations WHERE id = ?').get(created.id) as {
      next_check_at: string;
    };
    assert.equal(row.next_check_at, '2026-07-05T01:05:00.000Z');
    assert.equal(context.store.getNextCheckAt(created.id), '2026-07-05T01:05:00.000Z');
    assert.equal(context.facade.getAutomationNextCheckAt(created.id), '2026-07-05T01:05:00.000Z');
  } finally {
    context.close();
  }
});

test('decision workflow action fields survive the real store create/read/update round-trip', () => {
  const context = fixture();
  try {
    const created = context.store.create(createInput({
      title: 'AAPL Bull/Bear deep analysis',
      action: {
        kind: 'agent-prompt',
        promptTemplate: 'Conduct the bull/bear debate and record a decision.',
        executionMode: 'side-thread',
        workflowTemplate: 'deep-analysis',
        retrospectiveDelayHours: 24,
      },
    }));

    const reloaded = context.store.get(created.id);
    assert.equal(reloaded?.action.workflowTemplate, 'deep-analysis');
    assert.equal(reloaded?.action.retrospectiveDelayHours, 24);

    const updated = context.store.update(created.id, {
      action: {
        kind: 'agent-prompt',
        promptTemplate: 'Evaluate the decision against realized data.',
        executionMode: 'side-thread',
        retrospectiveTarget: {
          monitorId: created.id,
          decisionId: 'dec_9f2e4a6b8c3d4e5f',
        },
      },
    });
    assert.deepEqual(updated.action.retrospectiveTarget, {
      monitorId: created.id,
      decisionId: 'dec_9f2e4a6b8c3d4e5f',
    });
    assert.equal(
      context.store.get(created.id)?.action.retrospectiveTarget?.decisionId,
      'dec_9f2e4a6b8c3d4e5f',
    );
  } finally {
    context.close();
  }
});

test('listDueAutomationIds returns only automations whose next_check_at is at or before now', () => {
  const context = fixture();
  try {
    const due = context.store.create(createInput({ title: 'Due' }));
    const future = context.store.create(createInput({ title: 'Future' }));
    const unset = context.store.create(createInput({ title: 'Unset' }));
    const disabled = context.store.create(createInput({ title: 'Disabled' }));
    const blocked = context.store.create(createInput({ title: 'Blocked' }));
    context.store.updateState(due.id, { nextCheckAt: '2026-07-05T01:05:00.000Z' });
    context.store.updateState(future.id, { nextCheckAt: '2026-07-05T02:00:00.000Z' });
    context.store.updateState(disabled.id, { nextCheckAt: '2026-07-05T01:05:00.000Z' });
    context.store.update(disabled.id, { enabled: false });
    context.store.updateState(blocked.id, {
      nextCheckAt: '2026-07-05T01:05:00.000Z',
      health: 'blocked',
      blockedReason: 'Provider unavailable',
    });

    const atDue = context.store.listDueAutomationIds(new Date('2026-07-05T01:05:00.000Z'));
    assert.equal(atDue.size, 1);
    assert.equal(atDue.has(due.id), true);
    assert.equal(atDue.has(future.id), false);
    assert.equal(atDue.has(unset.id), false);
    assert.equal(atDue.has(disabled.id), false);
    assert.equal(atDue.has(blocked.id), false);

    const atLater = context.store.listDueAutomationIds(new Date('2026-07-05T02:00:00.000Z'));
    assert.equal(atLater.size, 2);
    assert.equal(atLater.has(due.id), true);
    assert.equal(atLater.has(future.id), true);

    const facadeDue = context.facade.listDueAutomationIds(new Date('2026-07-05T01:05:00.000Z'));
    assert.equal(facadeDue.size, 1);
    assert.equal(facadeDue.has(due.id), true);
  } finally {
    context.close();
  }
});

test('listIdsMissingNextCheckAt returns only automations whose next_check_at is null', () => {
  const context = fixture();
  try {
    const unsetA = context.store.create(createInput({ title: 'Unset A' }));
    const unsetB = context.store.create(createInput({ title: 'Unset B' }));
    const scheduled = context.store.create(createInput({ title: 'Scheduled' }));
    context.store.updateState(scheduled.id, { nextCheckAt: '2026-07-05T02:00:00.000Z' });

    const missing = context.store.listIdsMissingNextCheckAt();
    assert.equal(missing.size, 2);
    assert.equal(missing.has(unsetA.id), true);
    assert.equal(missing.has(unsetB.id), true);
    assert.equal(missing.has(scheduled.id), false);

    const facadeMissing = context.facade.listAutomationIdsMissingNextCheckAt();
    assert.equal(facadeMissing.size, 2);
    assert.equal(facadeMissing.has(unsetA.id), true);

    context.store.updateState(unsetA.id, { nextCheckAt: '2026-07-05T03:00:00.000Z' });
    const afterUpdate = context.store.listIdsMissingNextCheckAt();
    assert.equal(afterUpdate.size, 1);
    assert.equal(afterUpdate.has(unsetA.id), false);
    assert.equal(afterUpdate.has(unsetB.id), true);
  } finally {
    context.close();
  }
});

test('listLatestFinishedEvaluationByOrigin returns the most recent finished evaluation per automation', () => {
  const context = fixture();
  try {
    const monitor = context.store.createTrusted({
      ...createInput({ title: 'Monitor' }),
      originKind: 'automation-monitor',
    });
    const otherWorkspace = context.store.createTrusted({
      ...createInput({ workspaceId: 'workspace-2', title: 'Other' }),
      originKind: 'automation-monitor',
    });

    const earlier = context.store.createEvaluation(monitor.id, {
      activationKind: 'provider-event',
      startedAt: '2026-07-05T01:00:00.000Z',
    });
    context.store.finishEvaluation(earlier.id, {
      conditionOutcome: 'matched',
      triggerDecision: 'triggered',
      finishedAt: '2026-07-05T01:00:05.000Z',
    });
    const later = context.store.createEvaluation(monitor.id, {
      activationKind: 'provider-event',
      startedAt: '2026-07-05T02:00:00.000Z',
    });
    context.store.finishEvaluation(later.id, {
      conditionOutcome: 'matched',
      triggerDecision: 'triggered',
      finishedAt: '2026-07-05T02:00:05.000Z',
    });
    const running = context.store.createEvaluation(monitor.id, {
      activationKind: 'provider-event',
      startedAt: '2026-07-05T03:00:00.000Z',
    });
    const other = context.store.createEvaluation(otherWorkspace.id, {
      activationKind: 'provider-event',
      startedAt: '2026-07-05T01:00:00.000Z',
    });
    context.store.finishEvaluation(other.id, {
      conditionOutcome: 'matched',
      triggerDecision: 'triggered',
      finishedAt: '2026-07-05T01:00:05.000Z',
    });
    void running;

    const all = context.store.listLatestFinishedEvaluationByOrigin('automation-monitor');
    assert.equal(all.size, 2);
    assert.equal(all.get(monitor.id)?.id, later.id);
    assert.equal(all.get(otherWorkspace.id)?.id, other.id);

    const scoped = context.store.listLatestFinishedEvaluationByOrigin('automation-monitor', 'workspace-1');
    assert.equal(scoped.size, 1);
    assert.equal(scoped.get(monitor.id)?.id, later.id);

    const facadeScoped = context.facade.listLatestFinishedAutomationEvaluationByOrigin('automation-monitor', 'workspace-1');
    assert.equal(facadeScoped.get(monitor.id)?.id, later.id);
  } finally {
    context.close();
  }
});

test('listLatestRunByOrigin returns the most recent run per automation', () => {
  const context = fixture();
  try {
    const job = context.store.createTrusted({
      ...createInput({ title: 'Job' }),
      originKind: 'scheduled-job',
    });

    const evaluations = ['2026-07-05T01:00:00.000Z', '2026-07-05T02:00:00.000Z'].map((finishedAt, index) => {
      const evaluation = context.store.createEvaluation(job.id, {
        activationKind: 'cron',
        startedAt: `2026-07-05T0${index + 1}:00:00.000Z`,
      });
      context.store.finishEvaluation(evaluation.id, {
        conditionOutcome: 'matched',
        triggerDecision: 'triggered',
        finishedAt,
      });
      return evaluation;
    });
    const earlierRun = context.store.createRun(job.id, evaluations[0]!.id, { status: 'succeeded', createdAt: '2026-07-05T01:00:00.000Z' });
    const laterRun = context.store.createRun(job.id, evaluations[1]!.id, { status: 'failed', error: 'boom', createdAt: '2026-07-05T02:00:00.000Z' });
    void earlierRun;

    const all = context.store.listLatestRunByOrigin('scheduled-job');
    assert.equal(all.size, 1);
    assert.equal(all.get(job.id)?.id, laterRun.id);
    assert.equal(all.get(job.id)?.status, 'failed');

    const facadeAll = context.facade.listLatestAutomationRunByOrigin('scheduled-job');
    assert.equal(facadeAll.get(job.id)?.id, laterRun.id);
  } finally {
    context.close();
  }
});

test('listLatestEvaluationWithStateByOrigin returns the most recent finished-with-state evaluation per automation', () => {
  const context = fixture();
  try {
    const monitor = context.store.createTrusted({
      ...createInput({ title: 'Monitor' }),
      originKind: 'automation-monitor',
    });

    const withoutState = context.store.createEvaluation(monitor.id, {
      activationKind: 'provider-event',
      startedAt: '2026-07-05T01:00:00.000Z',
    });
    context.store.finishEvaluation(withoutState.id, {
      conditionOutcome: 'matched',
      triggerDecision: 'triggered',
      finishedAt: '2026-07-05T01:00:05.000Z',
    });
    const withState = context.store.createEvaluation(monitor.id, {
      activationKind: 'provider-event',
      startedAt: '2026-07-05T02:00:00.000Z',
    });
    context.store.finishEvaluation(withState.id, {
      conditionOutcome: 'matched',
      triggerDecision: 'triggered',
      finishedAt: '2026-07-05T02:00:05.000Z',
      nextState: { counter: 1 },
    });

    const all = context.store.listLatestEvaluationWithStateByOrigin('automation-monitor');
    assert.equal(all.size, 1);
    assert.equal(all.get(monitor.id)?.id, withState.id);
    const finished = all.get(monitor.id);
    assert.equal(finished?.status, 'finished');
    if (finished?.status === 'finished') {
      assert.deepEqual(finished.nextState, { counter: 1 });
    }

    const facadeAll = context.facade.listLatestAutomationEvaluationWithStateByOrigin('automation-monitor');
    assert.equal(facadeAll.get(monitor.id)?.id, withState.id);
  } finally {
    context.close();
  }
});

test('list filters by origin kind when provided', () => {
  const context = fixture();
  try {
    const monitor = context.store.createTrusted({
      ...createInput({ title: 'Monitor' }),
      originKind: 'automation-monitor',
    });
    const job = context.store.createTrusted({
      ...createInput({ title: 'Job' }),
      originKind: 'scheduled-job',
    });
    void monitor;
    void job;

    assert.equal(context.store.list().length, 2);
    assert.equal(context.store.list(undefined, 'automation-monitor').length, 1);
    assert.equal(context.store.list(undefined, 'scheduled-job').length, 1);
    assert.equal(context.facade.listAutomations(undefined, 'scheduled-job').length, 1);
  } finally {
    context.close();
  }
});

test('reconciles queued and running action runs as interrupted after restart', () => {
  const context = fixture();
  try {
    const createdRuns = (['queued', 'running'] as const).map((status, index) => {
      const automation = context.store.create(createInput({ title: `Automation ${index}` }));
      const evaluation = context.store.createEvaluation(automation.id, {
        activationKind: 'once',
        startedAt: `2026-07-05T07:0${index}:00.000Z`,
      });
      context.store.finishEvaluation(evaluation.id, {
        conditionOutcome: 'matched',
        triggerDecision: 'triggered',
        finishedAt: `2026-07-05T07:0${index}:01.000Z`,
      });
      return context.store.createRun(automation.id, evaluation.id, { status });
    });

    const recovered = context.store.reconcileInterruptedRuns(
      'Automation action interrupted by Local AI Core restart.',
      '2026-07-05T08:00:00.000Z',
    );
    assert.deepEqual(new Set(recovered.map((run) => run.id)), new Set(createdRuns.map((run) => run.id)));
    for (const run of recovered) {
      assert.equal(run.status, 'failed');
      assert.equal(run.deliveryStatus, 'failed');
      assert.equal(run.finishedAt, '2026-07-05T08:00:00.000Z');
      assert.match(run.error || '', /interrupted.*restart/i);
    }
    assert.equal(context.facade.reconcileInterruptedAutomationRuns('again', '2026-07-05T08:01:00.000Z').length, 0);
  } finally {
    context.close();
  }
});

test('enforces blocked health reasons and clears stale reasons when health recovers', () => {
  const context = fixture();
  try {
    const automation = context.store.create(createInput());
    assert.throws(() => context.store.updateState(automation.id, { health: 'blocked' }), /blocked reason/i);
    assert.throws(
      () => context.store.updateState(automation.id, { health: 'blocked', blockedReason: '   ' }),
      /blocked reason/i,
    );

    const blocked = context.store.updateState(automation.id, {
      health: 'blocked',
      blockedReason: 'Sandbox unavailable',
    });
    assert.equal(blocked.blockedReason, 'Sandbox unavailable');

    const healthy = context.store.updateState(automation.id, { health: 'healthy' });
    assert.equal(healthy.health, 'healthy');
    assert.equal(healthy.blockedReason, undefined);
    assert.throws(() => context.store.updateState(automation.id, { health: 'blocked' }), /blocked reason/i);
  } finally {
    context.close();
  }
});

test('canonicalizes persisted timestamps and orders mixed offsets chronologically', () => {
  const context = fixture();
  try {
    const automation = context.store.create(createInput({
      activation: { kind: 'once', runAt: '2026-07-05T12:34:56.1+08:00' },
    }));
    assert.deepEqual(automation.activation, { kind: 'once', runAt: '2026-07-05T04:34:56.100Z' });

    const state = context.store.updateState(automation.id, {
      lastEvaluationAt: '2026-07-05T12:34:56.12+08:00',
      lastTriggeredAt: '2026-07-05T12:34:56.123+08:00',
      nextCheckAt: '2026-07-05T12:35:00+08:00',
    });
    assert.equal(state.lastEvaluationAt, '2026-07-05T04:34:56.120Z');
    assert.equal(state.lastTriggeredAt, '2026-07-05T04:34:56.123Z');
    const definitionRow = context.db.prepare('SELECT next_check_at FROM automations WHERE id = ?').get(automation.id) as {
      next_check_at: string;
    };
    assert.equal(definitionRow.next_check_at, '2026-07-05T04:35:00.000Z');

    const lexicallyLater = context.store.createEvaluation(automation.id, {
      activationKind: 'once',
      startedAt: '2026-07-05T00:30:00.12+14:00',
    });
    context.store.finishEvaluation(lexicallyLater.id, {
      conditionOutcome: 'skipped',
      triggerDecision: 'not_evaluated',
      finishedAt: '2026-07-05T00:30:01.1+14:00',
      nextState: { marker: 'chronologically-older' },
    });
    const chronologicallyLater = context.store.createEvaluation(automation.id, {
      activationKind: 'once',
      startedAt: '2026-07-04T23:00:00.123-02:00',
    });
    context.store.finishEvaluation(chronologicallyLater.id, {
      conditionOutcome: 'skipped',
      triggerDecision: 'not_evaluated',
      finishedAt: '2026-07-04T23:00:01.12-02:00',
      nextState: { marker: 'chronologically-later' },
    });
    assert.equal(context.store.listEvaluations(automation.id)[0]?.id, chronologicallyLater.id);

    const oldByUtc = context.store.createEvaluation(automation.id, {
      activationKind: 'once',
      startedAt: '2026-06-06T00:00:00.123+14:00',
    });
    context.store.pruneEvaluations(new Date('2026-07-05T12:00:00.000Z'));
    assert.ok(!context.store.listEvaluations(automation.id).some((entry) => entry.id === oldByUtc.id));

    context.store.pruneEvaluations(new Date('2027-07-05T00:00:00.000Z'));
    const retained = context.store.listEvaluations(automation.id);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.id, chronologicallyLater.id);
    if (retained[0]?.status === 'finished') {
      assert.deepEqual(retained[0].nextState, { marker: 'chronologically-later' });
    }
  } finally {
    context.close();
  }
});

test('persists unified automations through the LocalCoreAcpStore facade', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'automation-facade-'));
  try {
    const first = new LocalCoreAcpStore(userDataPath);
    const created = first.createAutomation(createInput());
    first.updateAutomation(created.id, { title: 'Persisted automation' });
    first.updateAutomationState(created.id, { lastSuccessfulMatch: true, health: 'healthy' });
    first.close();

    const reopened = new LocalCoreAcpStore(userDataPath);
    assert.equal(reopened.getAutomation(created.id)?.title, 'Persisted automation');
    assert.equal(reopened.getAutomation(created.id)?.lastSuccessfulMatch, true);
    reopened.close();
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('keeps evaluations and action runs separate while enforcing the evaluation lifecycle', () => {
  const context = fixture();
  try {
    const automation = context.store.create(createInput());
    const evaluation = context.store.createEvaluation(automation.id, {
      activationKind: 'cron',
      startedAt: '2026-07-05T02:00:00.000Z',
    });
    assert.deepEqual(evaluation, {
      id: evaluation.id,
      automationId: automation.id,
      status: 'running',
      activationKind: 'cron',
      startedAt: '2026-07-05T02:00:00.000Z',
    });
    assert.throws(
      () => context.store.finishEvaluation(evaluation.id, {
        conditionOutcome: 'error',
        triggerDecision: 'not_rising',
        finishedAt: '2026-07-05T02:00:01.000Z',
      } as never),
      /trigger decision/i,
    );

    const finished = context.store.finishEvaluation(evaluation.id, {
      conditionOutcome: 'matched',
      triggerDecision: 'triggered',
      triggeredAt: '2026-07-05T02:00:01.000Z',
      finishedAt: '2026-07-05T02:00:01.000Z',
      durationMs: 1_000,
      payload: { status: 'ok' },
    });
    assert.equal(finished.status, 'finished');
    assert.throws(
      () => context.store.finishEvaluation(evaluation.id, {
        conditionOutcome: 'not_matched',
        triggerDecision: 'not_rising',
        finishedAt: '2026-07-05T02:00:02.000Z',
      }),
      /already finished/i,
    );

    const run = context.store.createRun(automation.id, evaluation.id, { status: 'running' });
    assert.equal(run.executionMode, 'side-thread');
    assert.equal(context.store.listEvaluations(automation.id).length, 1);
    assert.equal(context.store.listRuns(automation.id).length, 1);
    assert.equal(context.store.updateRun(run.id, {
      status: 'succeeded',
      acpRunId: 'acp-run-1',
      finishedAt: '2026-07-05T02:01:00.000Z',
    }).status, 'succeeded');
  } finally {
    context.close();
  }
});

test('creates at most one action run only for a triggered matched evaluation', () => {
  const context = fixture();
  try {
    const automation = context.store.create(createInput());
    const running = context.store.createEvaluation(automation.id, {
      activationKind: 'cron',
      startedAt: '2026-07-05T02:10:00.000Z',
    });
    assert.throws(() => context.store.createRun(automation.id, running.id), /finished.*matched.*triggered/i);

    const rejectedResults = [
      { conditionOutcome: 'not_matched', triggerDecision: 'not_rising' },
      { conditionOutcome: 'error', triggerDecision: 'not_evaluated' },
      { conditionOutcome: 'skipped', triggerDecision: 'not_evaluated' },
    ] as const;
    for (const [index, result] of rejectedResults.entries()) {
      const evaluation = context.store.createEvaluation(automation.id, {
        activationKind: 'cron',
        startedAt: `2026-07-05T02:1${index + 1}:00.000Z`,
      });
      context.store.finishEvaluation(evaluation.id, {
        ...result,
        finishedAt: `2026-07-05T02:1${index + 1}:01.000Z`,
      });
      assert.throws(() => context.store.createRun(automation.id, evaluation.id), /finished.*matched.*triggered/i);
    }

    const triggered = context.store.createEvaluation(automation.id, {
      activationKind: 'cron',
      startedAt: '2026-07-05T02:20:00.000Z',
    });
    context.store.finishEvaluation(triggered.id, {
      conditionOutcome: 'matched',
      triggerDecision: 'triggered',
      finishedAt: '2026-07-05T02:20:01.000Z',
    });
    context.store.createRun(automation.id, triggered.id);
    assert.throws(() => context.store.createRun(automation.id, triggered.id), /already has an action run|unique/i);
  } finally {
    context.close();
  }
});

test('ignores extra runtime keys that attempt to overwrite protected persisted fields', () => {
  const context = fixture();
  try {
    const automation = context.store.create({
      ...createInput(),
      id: 'attacker-automation',
      health: 'blocked',
      originKind: 'automation-monitor',
      legacyMetadata: { scheduledDescription: 'attacker' },
      createdAt: '2020-01-01T00:00:00.000Z',
    } as never);
    assert.notEqual(automation.id, 'attacker-automation');
    assert.equal(automation.health, 'healthy');
    assert.equal(automation.originKind, 'native');
    assert.equal(automation.legacyMetadata, undefined);

    const updated = context.store.update(automation.id, {
      title: 'Safe update',
      id: 'attacker-update',
      workspaceId: 'attacker-workspace',
      health: 'blocked',
      createdAt: '2020-01-01T00:00:00.000Z',
      legacyMetadata: { scheduledDescription: 'attacker-update' },
    } as never);
    assert.equal(updated.id, automation.id);
    assert.equal(updated.workspaceId, 'workspace-1');
    assert.equal(updated.health, 'healthy');
    assert.equal(updated.createdAt, automation.createdAt);
    assert.equal(updated.legacyMetadata, undefined);

    const evaluation = context.store.createEvaluation(automation.id, {
      activationKind: 'cron',
      startedAt: '2026-07-05T03:00:00.000Z',
      id: 'attacker-evaluation',
      automationId: 'attacker-automation',
      status: 'finished',
    } as never);
    assert.notEqual(evaluation.id, 'attacker-evaluation');
    assert.equal(evaluation.automationId, automation.id);
    assert.equal(evaluation.status, 'running');

    const finished = context.store.finishEvaluation(evaluation.id, {
      conditionOutcome: 'matched',
      triggerDecision: 'triggered',
      finishedAt: '2026-07-05T03:00:01.000Z',
      id: 'attacker-finished-evaluation',
      automationId: 'attacker-automation',
      activationKind: 'once',
      startedAt: '2020-01-01T00:00:00.000Z',
      status: 'running',
    } as never);
    assert.equal(finished.id, evaluation.id);
    assert.equal(finished.automationId, automation.id);
    assert.equal(finished.activationKind, 'cron');
    assert.equal(finished.startedAt, '2026-07-05T03:00:00.000Z');
    assert.equal(finished.status, 'finished');

    const run = context.store.createRun(automation.id, evaluation.id, {
      status: 'running',
      id: 'attacker-run',
      automationId: 'attacker-automation',
      evaluationId: 'attacker-evaluation',
      executionMode: 'same-thread',
      createdAt: '2020-01-01T00:00:00.000Z',
    } as never);
    assert.notEqual(run.id, 'attacker-run');
    assert.equal(run.automationId, automation.id);
    assert.equal(run.evaluationId, evaluation.id);
    assert.equal(run.executionMode, 'side-thread');

    const updatedRun = context.store.updateRun(run.id, {
      status: 'succeeded',
      id: 'attacker-updated-run',
      automationId: 'attacker-automation',
      evaluationId: 'attacker-evaluation',
      executionMode: 'same-thread',
      createdAt: '2020-01-01T00:00:00.000Z',
    } as never);
    assert.equal(updatedRun.id, run.id);
    assert.equal(updatedRun.automationId, automation.id);
    assert.equal(updatedRun.evaluationId, evaluation.id);
    assert.equal(updatedRun.executionMode, 'side-thread');
    assert.equal(updatedRun.createdAt, run.createdAt);

    const evaluationRow = context.db.prepare('SELECT automation_id, evaluation_json FROM automation_evaluations WHERE id = ?')
      .get(evaluation.id) as { automation_id: string; evaluation_json: string };
    const evaluationJson = JSON.parse(evaluationRow.evaluation_json) as { id: string; automationId: string };
    assert.deepEqual(
      { indexed: evaluationRow.automation_id, jsonId: evaluationJson.id, jsonAutomationId: evaluationJson.automationId },
      { indexed: automation.id, jsonId: evaluation.id, jsonAutomationId: automation.id },
    );

    const runRow = context.db.prepare('SELECT automation_id, evaluation_id, run_json FROM automation_runs WHERE id = ?')
      .get(run.id) as { automation_id: string; evaluation_id: string; run_json: string };
    const runJson = JSON.parse(runRow.run_json) as { id: string; automationId: string; evaluationId: string };
    assert.deepEqual(
      {
        indexedAutomation: runRow.automation_id,
        indexedEvaluation: runRow.evaluation_id,
        jsonId: runJson.id,
        jsonAutomationId: runJson.automationId,
        jsonEvaluationId: runJson.evaluationId,
      },
      {
        indexedAutomation: automation.id,
        indexedEvaluation: evaluation.id,
        jsonId: run.id,
        jsonAutomationId: automation.id,
        jsonEvaluationId: evaluation.id,
      },
    );
  } finally {
    context.close();
  }
});

test('prunes old or excess evaluations per automation without deleting runs', () => {
  const context = fixture();
  try {
    const automation = context.store.create(createInput());
    let protectedEvaluationId = '';
    let protectedRunId = '';
    for (let index = 0; index < 1_002; index += 1) {
      const startedAt = new Date(Date.UTC(2026, 6, 4, 0, 0, index)).toISOString();
      const evaluation = context.store.createEvaluation(automation.id, { activationKind: 'cron', startedAt });
      context.store.finishEvaluation(evaluation.id, index === 0
        ? { conditionOutcome: 'matched', triggerDecision: 'triggered', finishedAt: startedAt }
        : { conditionOutcome: 'not_matched', triggerDecision: 'not_rising', finishedAt: startedAt });
      if (index === 0) {
        protectedEvaluationId = evaluation.id;
        protectedRunId = context.store.createRun(automation.id, evaluation.id).id;
      }
    }
    const old = context.store.createEvaluation(automation.id, {
      activationKind: 'cron',
      startedAt: '2026-05-01T00:00:00.000Z',
    });
    const otherAutomation = context.store.create(createInput({ workspaceId: 'workspace-2', title: 'Other automation' }));
    for (const startedAt of ['2026-07-04T00:00:00.000Z', '2026-07-04T00:00:01.000Z']) {
      context.store.createEvaluation(otherAutomation.id, { activationKind: 'cron', startedAt });
    }

    const removed = context.store.pruneEvaluations(new Date('2026-07-05T00:00:00.000Z'));
    assert.equal(removed, 2);
    assert.equal(context.store.listEvaluations(automation.id).length, 1_001);
    assert.ok(context.store.listEvaluations(automation.id).some((entry) => entry.id === protectedEvaluationId));
    assert.ok(context.store.listRuns(automation.id).some((entry) => entry.id === protectedRunId));
    assert.ok(!context.store.listEvaluations(automation.id).some((entry) => entry.id === old.id));
    assert.equal(context.store.listEvaluations(otherAutomation.id).length, 2);
  } finally {
    context.close();
  }
});

test('fails legacy import atomically with row context when any legacy row is malformed', () => {
  const context = fixture();
  try {
    const validScheduled = context.facade.createScheduledJob({
      workspaceId: 'workspace-1',
      platform: 'local',
      route: { type: 'local.thread', channelId: 'workspace-1' },
      triggerType: 'cron',
      cronExpr: '0 * * * *',
      promptTemplate: 'Valid legacy job',
    });
    const malformedMonitor = context.facade.createAutomationMonitor({
      workspaceId: 'workspace-1',
      title: 'Malformed legacy monitor',
      sourceType: 'stock.quote',
      condition: { metric: 'price', operator: '>=', value: 200 },
      promptTemplate: 'Do not import partially',
      platform: 'local',
      route: { type: 'local.thread', channelId: 'workspace-1' },
    });
    context.db.prepare('UPDATE automation_monitors SET condition_json = ? WHERE id = ?')
      .run('{malformed', malformedMonitor.id);

    // Migration is deliberately fail-fast and atomic: one malformed row rolls back every valid row in the batch.
    assert.throws(
      () => context.store.importLegacyRecords(),
      new RegExp(`automation monitor ${malformedMonitor.id} condition`, 'i'),
    );
    assert.equal(context.store.get(validScheduled.id), undefined);
    assert.equal(context.store.get(malformedMonitor.id), undefined);
    assert.equal(context.store.list().length, 0);
  } finally {
    context.close();
  }
});

test('detects corruption in every duplicated evaluation and run column', () => {
  const context = fixture();
  try {
    const automation = context.store.create(createInput());
    const evaluation = context.store.createEvaluation(automation.id, {
      activationKind: 'cron',
      scriptVersionId: 'version-1',
      startedAt: '2026-07-05T05:00:00.000Z',
    });
    context.store.finishEvaluation(evaluation.id, {
      conditionOutcome: 'matched',
      triggerDecision: 'triggered',
      finishedAt: '2026-07-05T05:00:01.000Z',
    });
    const run = context.store.createRun(automation.id, evaluation.id, { status: 'running' });

    const evaluationCorruptions = [
      ['status', 'running'],
      ['activation_kind', 'once'],
      ['script_version_id', null],
      ['started_at', '2026-07-05T05:00:02.000Z'],
      ['finished_at', null],
    ] as const;
    const originalEvaluationRow = context.db.prepare(`
      SELECT status, activation_kind, script_version_id, started_at, finished_at
      FROM automation_evaluations WHERE id = ?
    `).get(evaluation.id) as Record<string, string | null>;
    for (const [column, corruptValue] of evaluationCorruptions) {
      context.db.prepare(`UPDATE automation_evaluations SET ${column} = ? WHERE id = ?`).run(corruptValue, evaluation.id);
      assert.throws(
        () => context.store.listEvaluations(automation.id),
        new RegExp(`automation evaluation ${evaluation.id} contains invalid persisted data`, 'i'),
      );
      context.db.prepare(`UPDATE automation_evaluations SET ${column} = ? WHERE id = ?`)
        .run(originalEvaluationRow[column] ?? null, evaluation.id);
    }

    const originalRunRow = context.db.prepare('SELECT status, created_at FROM automation_runs WHERE id = ?')
      .get(run.id) as Record<string, string>;
    for (const [column, corruptValue] of [
      ['status', 'succeeded'],
      ['created_at', '2026-07-05T05:00:02.000Z'],
    ] as const) {
      context.db.prepare(`UPDATE automation_runs SET ${column} = ? WHERE id = ?`).run(corruptValue, run.id);
      assert.throws(
        () => context.store.listRuns(automation.id),
        new RegExp(`automation run ${run.id} contains invalid persisted data`, 'i'),
      );
      context.db.prepare(`UPDATE automation_runs SET ${column} = ? WHERE id = ?`)
        .run(originalRunRow[column], run.id);
    }
  } finally {
    context.close();
  }
});

test('enforces automation foreign keys and cascades child records on deletion', () => {
  const context = fixture();
  try {
    const automation = context.store.create(createInput());
    const evaluation = context.store.createEvaluation(automation.id, {
      activationKind: 'cron',
      startedAt: '2026-07-05T06:00:00.000Z',
    });
    context.store.finishEvaluation(evaluation.id, {
      conditionOutcome: 'matched',
      triggerDecision: 'triggered',
      finishedAt: '2026-07-05T06:00:01.000Z',
    });
    context.store.createRun(automation.id, evaluation.id);
    context.store.delete(automation.id);

    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM automation_evaluations').get() as { count: number }).count, 0);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM automation_runs').get() as { count: number }).count, 0);
    assert.deepEqual(context.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    context.close();
  }
});

test('imports legacy scheduled jobs and monitors once while preserving IDs and origins', () => {
  const context = fixture();
  try {
    const scheduled = context.facade.createScheduledJob({
      workspaceId: 'workspace-1',
      platform: 'local',
      route: { type: 'local.thread', channelId: 'workspace-1' },
      executionMode: 'same-thread',
      triggerType: 'cron',
      cronExpr: '0 * * * *',
      promptTemplate: 'Run hourly summary',
      description: 'Hourly summary',
    });
    const monitor = context.facade.createAutomationMonitor({
      workspaceId: 'workspace-1',
      title: 'Price alert',
      sourceType: 'stock.quote',
      sourceConfig: { symbol: 'AAPL' },
      condition: { metric: 'price', operator: '>=', value: 200 },
      promptTemplate: 'Explain the price move',
      platform: 'local',
      route: { type: 'local.thread', channelId: 'workspace-1' },
      executionMode: 'side-thread',
    });
    const legacyState = {
      lastEventId: 'event-42',
      lastEventAt: '2026-07-05T04:00:00.000Z',
      latestPrice: 201,
      previousPrice: 198,
      payload: { symbol: 'AAPL', exchange: 'NASDAQ' },
    };
    context.facade.updateAutomationMonitorState(monitor.id, { lastState: legacyState });

    assert.deepEqual(context.store.importLegacyRecords(), { scheduled: 1, monitors: 1 });
    assert.deepEqual(context.store.importLegacyRecords(), { scheduled: 0, monitors: 0 });
    assert.equal(context.store.get(scheduled.id)?.originKind, 'scheduled-job');
    assert.deepEqual(context.store.get(scheduled.id)?.legacyMetadata, { scheduledDescription: 'Hourly summary' });
    assert.equal(context.store.get(scheduled.id)?.activation.kind, 'cron');
    assert.equal(context.store.get(monitor.id)?.originKind, 'automation-monitor');
    assert.equal(context.store.get(monitor.id)?.activation.kind, 'provider-event');
    assert.equal(context.store.get(monitor.id)?.condition.kind, 'expression');
    const importedEvaluations = context.store.listEvaluations(monitor.id);
    assert.equal(importedEvaluations.length, 1);
    assert.equal(importedEvaluations[0]?.status, 'finished');
    assert.equal(importedEvaluations[0]?.conditionOutcome, 'skipped');
    assert.equal(importedEvaluations[0]?.triggerDecision, 'not_evaluated');
    assert.deepEqual(importedEvaluations[0]?.nextState, legacyState);
    context.store.pruneEvaluations(new Date('2027-07-05T00:00:00.000Z'));
    const retainedStateEvaluation = context.store.listEvaluations(monitor.id)[0];
    assert.equal(retainedStateEvaluation?.status, 'finished');
    if (retainedStateEvaluation?.status === 'finished') {
      assert.deepEqual(retainedStateEvaluation.nextState, legacyState);
    }
  } finally {
    context.close();
  }
});

test('rejects malformed persisted JSON with row context', () => {
  const context = fixture();
  try {
    const automation = context.store.create(createInput());
    context.db.prepare('UPDATE automations SET condition_json = ? WHERE id = ?').run('{oops', automation.id);
    assert.throws(() => context.store.get(automation.id), new RegExp(`automation ${automation.id} condition`, 'i'));
  } finally {
    context.close();
  }
});

test('filters automations by workspaceId and channelId', () => {
  const context = fixture();
  try {
    context.store.create(createInput({
      workspaceId: 'ws-1',
      title: 'Task in channel A',
      delivery: { platform: 'lark', route: { type: 'channel.chat', channelId: 'chat-A' } },
    }));
    context.store.create(createInput({
      workspaceId: 'ws-1',
      title: 'Task in channel B',
      delivery: { platform: 'lark', route: { type: 'channel.chat', channelId: 'chat-B' } },
    }));
    context.store.create(createInput({
      workspaceId: 'ws-2',
      title: 'Task in ws2 channel A',
      delivery: { platform: 'lark', route: { type: 'channel.chat', channelId: 'chat-A' } },
    }));

    // List all in ws-1
    assert.equal(context.store.list('ws-1').length, 2);
    // List ws-1 + chat-A
    const ws1ChatA = context.store.list('ws-1', undefined, 'chat-A');
    assert.equal(ws1ChatA.length, 1);
    assert.equal(ws1ChatA[0]?.title, 'Task in channel A');
    // List ws-1 + chat-B
    const ws1ChatB = context.store.list('ws-1', undefined, 'chat-B');
    assert.equal(ws1ChatB.length, 1);
    assert.equal(ws1ChatB[0]?.title, 'Task in channel B');
    // List ws-2 + chat-A
    const ws2ChatA = context.store.list('ws-2', undefined, 'chat-A');
    assert.equal(ws2ChatA.length, 1);
    assert.equal(ws2ChatA[0]?.title, 'Task in ws2 channel A');
    // List non-existent channel
    assert.equal(context.store.list('ws-1', undefined, 'chat-non-existent').length, 0);
  } finally {
    context.close();
  }
});

test('legacy migration safely imports scheduled job with empty or missing route channelId', () => {
  const context = fixture();
  try {
    // Insert a legacy row directly into scheduled_jobs without channelId
    context.db.prepare(`
      INSERT INTO scheduled_jobs (
        id, workspace_id, platform, route_type, route_config, trigger_type, cron_expr,
        prompt_template, description, enabled, concurrency_policy, created_at, updated_at, execution_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-job-1',
      'ws-legacy',
      'local',
      'local.thread',
      JSON.stringify({ type: 'local.thread' }), // No channelId!
      'cron',
      '0 9 * * *',
      'Legacy prompt',
      'Legacy description',
      1,
      'skip_if_running',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      'same-thread',
    );

    // Import legacy records
    const imported = context.store.importLegacyRecords();
    assert.equal(imported.scheduled, 1);

    const record = context.store.get('legacy-job-1');
    assert(record);
    assert.equal(record.delivery?.route?.channelId, 'ws-legacy');
  } finally {
    context.close();
  }
});


