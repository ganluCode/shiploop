import { expect, it } from 'vitest';
import { openDeliveryVertical } from '../../helpers/p03-8/delivery-vertical.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

it.each([0, 1, 2])('default Core scan settles a Feature check exit=%i without restoring Task leases or calling another Runtime', async exitCode => {
  const check = { checkKey: 'tests', scope: 'task' as const, kind: 'command' as const,
    argv: [process.execPath, '-e', `const fs=require('node:fs');if(fs.readFileSync('README.md','utf8')!=='downstream\\n')process.exitCode=1;console.log('SHIPLOOP_NODE_CHECK_RESULT='+JSON.stringify({schemaVersion:1,protocol:'shiploop.node-check',collected:true,testCount:1,targets:['tests']}));if(${exitCode})process.exitCode=1;`],
    cwdRef: null, environmentRef: null, timeout: 5000, required: true, requirementRefs: [] };
  const policy = { checkDefinitions: [check], fullFallback: { checkRefs: ['tests'] }, featureChecks: ['tests'] };
  // Task machine results are explicitly seeded. Feature verification, process
  // identity registration, Git and business finalization use default Core code.
  const f = await openDeliveryVertical({ confirmProjectProfile: true, verificationPolicy: policy, reserveFinalResources: false,
    ...(exitCode !== 2 ? {} : { featureAutoFixPolicy: { enabled: true, maxTokenTotal: 10000, timeoutMs: 60000, maxTurns: 20,
      strategy: { runtime: 'fake', provider: 'test-provider', model: 'fake-model' } } }) });
  try {
    const { projectId, featureId, runId } = f.fixture;
    const before = f.db.prepare('SELECT count(*) AS n FROM attempts').get();
    const runtimeBefore = f.counts().runtimeCalls;
    expect(f.db.prepare('SELECT count(*) AS n FROM workspace_leases').get()).toEqual({ n: 0 });
    await f.core.workExecution.scan();
    const ledger = f.db.prepare('SELECT stage,reason FROM feature_closeouts WHERE project_id=? AND run_id=?').get(projectId, runId);
    const run = f.db.prepare('SELECT status,reason FROM runs WHERE id=?').get(runId);
    if (exitCode === 2) {
      expect({ ledger, run }).toMatchObject({ ledger: { stage: 'failed', reason: 'verification_failed' }, run: { status: 'failed' } });
      expect(f.db.prepare("SELECT count(*) AS n FROM verification_batches WHERE operation='FeatureVerification.full'").get()).toEqual({ n: 4 });
      expect(f.counts().runtimeCalls).toBe(runtimeBefore + 3);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM feature_repair_attempts WHERE stop_confirmed=1').get()).toEqual({ n: 3 });
      expect(f.db.prepare('SELECT DISTINCT locale FROM feature_repair_attempts').all()).toEqual([{ locale: 'en-US' }]);
      expect(() => f.db.prepare("UPDATE feature_repair_attempts SET locale='zh-CN'").run()).toThrow('feature repair locale immutable');
      expect(f.db.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual(before);
      expect(f.db.prepare("SELECT count(*) AS n FROM git_operations WHERE operation_type='feature_final_commit'").get()).toEqual({ n: 0 });
      return;
    }
    if (exitCode !== 0) {
      expect({ ledger, run }).toMatchObject({ ledger: { stage: 'failed', reason: 'verification_failed' }, run: { status: 'failed' } });
      expect(f.db.prepare('SELECT status FROM features WHERE id=?').get(featureId)).toEqual({ status: 'partial' });
      expect(f.db.prepare("SELECT count(*) AS n FROM git_operations WHERE operation_type='feature_final_commit'").get()).toEqual({ n: 0 });
      expect(f.db.prepare('SELECT evidence_ref FROM feature_closeouts WHERE run_id=?').get(runId))
        .toMatchObject({ evidence_ref: expect.any(String) });
      expect(f.counts().runtimeCalls).toBe(runtimeBefore);
      expect(f.db.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual(before);
      return;
    }
    expect({ ledger, run }, JSON.stringify({ ledger, run,
      batches: f.db.prepare('SELECT operation,status FROM verification_batches').all(),
      checks: f.db.prepare('SELECT status,output_tail FROM check_results').all() }))
      .toMatchObject({ ledger: { stage: 'completed' }, run: { status: 'succeeded' } });
    expect(f.db.prepare('SELECT status,delivery_status FROM features WHERE id=?').get(featureId))
      .toEqual({ status: 'completed', delivery_status: 'succeeded' });
    expect(f.db.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual(before);
    expect(f.counts().runtimeCalls).toBe(runtimeBefore);
    expect(f.db.prepare("SELECT count(*) AS n FROM verification_batches WHERE operation='FeatureVerification.full'").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT status FROM git_operations WHERE operation_type='feature_final_commit'").get())
      .toMatchObject({ status: expect.stringMatching(/^(succeeded|no_change)$/) });
    expect(f.db.prepare("SELECT count(*) AS n FROM run_dispatch_claims WHERE state='held'").get()).toEqual({ n: 0 });
    await f.core.workExecution.scan();
    expect(f.db.prepare("SELECT count(*) AS n FROM verification_batches WHERE operation='FeatureVerification.full'").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
}, 120_000);

it('repairs the failed Feature check then independently verifies and delivers without replaying passed Tasks', async () => {
  const check = { checkKey: 'tests', scope: 'task' as const, kind: 'command' as const,
    argv: [process.execPath, '-e', "const fs=require('node:fs');const ok=fs.readFileSync('README.md','utf8')==='downstream\\n';console.log('SHIPLOOP_NODE_CHECK_RESULT='+JSON.stringify({schemaVersion:1,protocol:'shiploop.node-check',collected:true,testCount:1,targets:['tests']}));process.exitCode=ok?0:1;"],
    cwdRef: null, environmentRef: null, timeout: 5000, required: true, requirementRefs: [] };
  const f = await openDeliveryVertical({ reserveFinalResources: false, repairReadme: 'downstream\n',
    verificationPolicy: { checkDefinitions: [check], fullFallback: { checkRefs: ['tests'] }, featureChecks: ['tests'] },
    featureAutoFixPolicy: { enabled: true,
      strategy: { runtime: 'fake', provider: 'test-provider', model: 'fake-model' } } });
  try {
    const { projectId, featureId, runId } = f.fixture;
    const workspace = f.db.prepare('SELECT canonical_path FROM managed_workspaces WHERE feature_id=?').get(featureId) as { canonical_path: string };
    writeFileSync(join(workspace.canonical_path, 'README.md'), 'broken\n');
    const attempts = f.db.prepare('SELECT COUNT(*) AS n FROM attempts').get();
    const calls = f.counts().runtimeCalls;
    await f.core.workExecution.scan();
    expect(f.db.prepare('SELECT stage,repair_count FROM feature_closeouts WHERE project_id=? AND run_id=?').get(projectId, runId))
      .toEqual({ stage: 'completed', repair_count: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual(attempts);
    expect(f.counts().runtimeCalls).toBe(calls + 1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM verification_batches WHERE operation='FeatureVerification.full'").get()).toEqual({ n: 2 });
    expect(f.db.prepare('SELECT status,stop_confirmed,result_ref FROM feature_repair_attempts').get())
      .toMatchObject({ status: 'completed', stop_confirmed: 1, result_ref: expect.any(String) });
  } finally { await f.close(); }
}, 120000);
