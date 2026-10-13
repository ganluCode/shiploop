import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeDuplicate, probeCrash, probeCancellation, probeStorageAndEvents, probeOrphan } from './probe.mjs';

test('real Durable deduplicates admitted request across SQLite reopen without another provider call', { timeout: 15000 }, async () => {
  const result = await probeDuplicate();
  assert.equal(result.submissionSame, true);
  assert.equal(result.userEntries, 1);
  assert.equal(result.providerCalls, 1);
  assert.equal(result.reopenedProviderCalls, 0);
  assert.equal(result.providerSessionSame, true);
  assert.equal(result.status, 'done');
  assert.equal(result.conflictingPayloadSame, true);
});

for (const [point, replay, effects, beforeHooks] of [
  ['before-tool', 'unsafe', 1, 2],
  ['execute', 'unsafe', 1, 1],
  ['after-tool', 'unsafe', 1, 1],
  ['execute', 'safe', 2, 1],
  ['after-tool', 'safe', 2, 1],
  ['after-commit', 'unsafe', 1, 1],
]) {
  test(`SIGKILL at ${point}, replay=${replay}: observe durable intent and effect count`, { timeout: 20000 }, async () => {
    const result = await probeCrash(point, replay);
    assert.equal(result.exit.signal, 'SIGKILL');
    assert.equal(result.effects, effects);
    assert.equal(result.beforeHooks, beforeHooks);
    assert.equal(result.status, 'done');
    assert.equal(result.liveTasks, 0);
    assert.equal(result.userEntries, 1);
    assert.equal(result.toolResults.length, 1);
    const checkpoint = result.checkpoints[0];
    assert.equal(checkpoint.kind, 'pi.tool');
    if (point === 'before-tool') assert.equal(checkpoint.state.checkpoint.phase, 'call');
    else if (point !== 'after-commit') assert.equal(checkpoint.state.checkpoint.phase, 'execute');
    if (replay === 'unsafe' && ['execute', 'after-tool'].includes(point)) {
      assert.match(JSON.stringify(result.toolResults), /interrupted/);
    }
  });
}

test('SIGTERM is a process exit, not a confirmed SDK cancel', { timeout: 20000 }, async () => {
  const result = await probeCrash('execute', 'unsafe', 'SIGTERM');
  assert.equal(result.exit.signal, 'SIGTERM');
  assert.equal(result.effects, 1);
  assert.match(JSON.stringify(result.toolResults), /interrupted/);
});

test('missing tool on reopen does not execute a stored-safe effect again', { timeout: 20000 }, async () => {
  const result = await probeCrash('execute', 'safe', 'SIGKILL', true);
  assert.equal(result.effects, 1);
  assert.equal(result.liveTasks, 0);
  assert.match(JSON.stringify(result.toolResults), /interrupted/);
});

for (const action of ['abort', 'close', 'non-cooperative']) {
  test(`${action}: waiter cancellation is separate from stopping invocation`, { timeout: 15000 }, async () => {
    const result = await probeCancellation(action);
    assert.equal(result.waiterRejected, true);
    assert.equal(result.stillRunningAfterWaitCancel, true);
    assert.equal(result.toolExited, true);
    if (action === 'abort') assert.equal(result.liveTasks, 0);
    if (action === 'non-cooperative') assert.equal(result.closePendingBeforeRelease, true);
  });
}

test('external tool process survives Harness SIGKILL and is explicitly cleaned up', { timeout: 20000 }, async () => {
  const result = await probeOrphan();
  assert.equal(result.parentSignal, 'SIGKILL');
  assert.equal(result.orphanAliveAfterParentExit, true);
  assert.equal(result.outputContinued, true);
});

test('SQLite snapshots, events, model choice and lack of single-writer admission', { timeout: 20000 }, async () => {
  const result = await probeStorageAndEvents();
  assert.equal(result.journal, 'wal');
  assert.equal(result.schemaVersion, 1);
  assert.ok(result.tables.includes('document_revisions'));
  assert.ok(result.duringOpen.includes('native.sqlite-wal'));
  assert.equal(result.snapshotEntries, result.copyEntries);
  assert.ok(result.copyEntries > 0);
  assert.equal(result.secondWriterOpened, true);
  assert.equal(result.writerCode, 0);
  assert.ok(result.eventTypes.includes('snapshot'));
  assert.ok(result.eventTypes.includes('message_end'));
  assert.ok(result.eventTypes.includes('tool_execution_start'));
  assert.ok(result.eventTypes.includes('tool_execution_end'));
  assert.ok(result.toolEvents.every(e => e.toolCallId === 'tool-1' && e.taskId !== undefined));
  assert.equal(result.reconnect.type, 'snapshot');
  assert.equal(result.reconnect.tools, 0);
  assert.equal(result.modelSwitch.dispatchedModel, 'faux-2');
  assert.equal(result.modelSwitch.providerSessionSame, true);
  assert.equal(result.modelSwitch.tools, 0);
});
