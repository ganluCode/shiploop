// F-003 trusted acceptance assembly. Every imported implementation is built.
// SQL below is SELECT only; production adapters own all business writes.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFakeWorkRuntimeFactory } from '../../../packages/core/dist/adapters/testing.js';
import { openSqliteStorageSession } from '../../../packages/core/dist/adapters/sqlite/session.js';
import { createSqliteAtomicCommandStore } from '../../../packages/core/dist/adapters/sqlite/atomic-commands.js';
import { createSqliteVerificationStore } from '../../../packages/core/dist/adapters/sqlite/verification-store.js';
import { createWorkspaceInspector } from '../../../packages/core/dist/adapters/fs/workspace-inspector.js';
import { createNodeTaskVerificationExecutor } from '../../../packages/core/dist/application/node-task-verification.js';
import { verificationCodeIdentity } from '../../../packages/core/dist/ports/verification-aggregate.js';
import { createCommandProcessAdapter } from '../../../packages/core/dist/adapters/process/command-process.js';
import { createThreeTaskDelivery } from './three-task-delivery.mjs';

const providers = [{ providerId: 'fake-provider', models: ['fake-model'] }];
const finish = { op: 'tool_command', name: 'probe' };
const scripts = [
  [{ op: 'write_file', path: 'README.md', content: 'chain-1\n' }, finish],
  [{ op: 'write_file', path: 'README.md', content: 'chain-1\nchain-2-first\n' },
    { op: 'write_file', path: 'chain-2.txt', content: 'retained marker\n' }, finish],
  [{ op: 'tool_command', name: 'repair' }],
  [{ op: 'write_file', path: 'chain-3.txt', content: 'chain-3\n' }, finish],
];

export function threeTaskRuntime(config) {
  return context => {
    const processes = createCommandProcessAdapter();
    const failureSteps = [
      { op: 'write_file', path: 'README.md', content: 'chain-1\n' },
      { op: 'write_file', path: 'chain-2.txt', content: 'retained marker\n' }, finish,
    ];
    const factories = (config.chain.persistentCheckFailure
      ? [failureSteps, [{ op: 'tool_command', name: 'failedRepair' }]] : scripts).map(steps => createFakeWorkRuntimeFactory({
      providers, commandProcess: processes,
      toolCommands: {
        probe: { argv: [process.execPath, '-e', 'process.stdout.write("real tool stopped")'], timeoutMs: 5000 },
        failedRepair: { argv: [process.execPath, '-e', `
          const fs = require('node:fs');
          const tracked = fs.readFileSync('README.md', 'utf8');
          const untracked = fs.readFileSync('chain-2.txt', 'utf8');
          if (!tracked.startsWith('chain-1\\n') || !untracked.startsWith('retained marker\\n')
            || tracked.slice('chain-1\\n'.length) !== untracked.slice('retained marker\\n'.length)) {
            throw Error('failed attempt scene lost');
          }
          fs.appendFileSync('README.md', 'repair\\n');
          fs.appendFileSync('chain-2.txt', 'repair\\n');
        `], timeoutMs: 5000 },
        repair: { argv: [process.execPath, '-e', `
          const fs = require('node:fs');
          if (fs.readFileSync('chain-2.txt', 'utf8') !== 'retained marker\\n') throw Error('untracked first attempt lost');
          if (fs.readFileSync('README.md', 'utf8') !== 'chain-1\\nchain-2-first\\n') throw Error('tracked first attempt lost');
          fs.appendFileSync('chain-2.txt', 'repaired\\n');
          fs.appendFileSync('README.md', 'chain-2-repaired\\n');
        `], timeoutMs: 5000 },
        ...config.toolCommands,
      },
      script: { schemaVersion: 1, steps },
    })(context));
    const starts = [];
    return {
      ...factories[0],
      entries: factories[0].entries.map(entry => ({ ...entry, adapter: {
        async start(request) {
          const { taskId } = request.identity;
          const secondStarts = starts.filter(start => start.taskId === 'chain-2').length;
          const index = config.chain.persistentCheckFailure ? (starts.length === 0 ? 0 : 1)
            : taskId === 'chain-1' ? 0 : taskId === 'chain-2' ? (secondStarts === 0 ? 1 : 2) : 3;
          starts.push({ taskId, attemptId: request.identity.attemptId, inputManifest: request.inputManifest });
          writeFileSync(join(config.chain.root, 'chain-starts.json'), JSON.stringify(starts));
          return factories[index].entries[0].adapter.start(request);
        },
      } })),
    };
  };
}

export function attachThreeTaskProbe(host, config, registerDelivery) {
  const core = host.core;
  const session = openSqliteStorageSession({ path: join(config.dataRoot, 'core.sqlite') });
  const db = session.database;
  const atomic = createSqliteAtomicCommandStore(session);
  const verificationStore = createSqliteVerificationStore(session);
  const processes = createCommandProcessAdapter();
  const inspector = createWorkspaceInspector({ authorizedRoots: [config.chain.root],
    confirmProcessIdentity: async identity => identity });
  const delivery = createThreeTaskDelivery({ core, session, atomic, verificationStore, inspector, processes });
  registerDelivery(delivery.dependencies);
  let active = Promise.resolve();
  let busy = false;
  let closed = false;
  const seen = new Set();
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 }).trimEnd();
  const artifactText = async (projectId, artifactId) => {
    const content = await core.artifactFileStore.openFinalRead({ projectId, artifactId });
    const chunks = [];
    for await (const chunk of content.stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  };
  async function verify(control) {
    const attempt = db.prepare('SELECT * FROM attempts WHERE task_id = ? AND status = ? ORDER BY number DESC LIMIT 1')
      .get(control.taskId, control.action === 'state' ? 'succeeded' : 'verifying');
    if (!attempt) throw Error('missing verifying attempt');
    const workspace = db.prepare('SELECT * FROM managed_workspaces WHERE feature_id = ?').get(attempt.feature_id);
    const baseline = {
      repositoryBindingId: workspace.repository_binding_id, repositoryBindingRevision: workspace.repository_binding_revision,
      repoIdentity: workspace.repo_identity, canonicalPath: workspace.canonical_path,
      gitCommonDir: workspace.git_common_dir, branch: workspace.branch, baseCommit: workspace.base_commit,
    };
    if (control.action === 'state') return { finalization: delivery.readState() };
    const resourceIdentity = { projectId: attempt.project_id, attemptId: attempt.id, owner: attempt.owner_id,
      hostInstanceId: attempt.host_instance_id, executionVersion: attempt.execution_version };
    const policyDigest = JSON.parse(attempt.input_snapshot).approval.checkPolicyDigest;
    const before = await inspector.inspect(baseline);
    const beforeIdentity = verificationCodeIdentity(before, { executionDigest: policyDigest });
    const beforeGit = { head: git(baseline.canonicalPath, ['rev-parse', 'HEAD']),
      tree: git(baseline.canonicalPath, ['rev-parse', 'HEAD^{tree}']),
      status: git(baseline.canonicalPath, ['status', '--porcelain=v1']) };
    const beforeFiles = Object.fromEntries(['README.md', 'chain-2.txt', 'chain-3.txt']
      .filter(path => existsSync(join(baseline.canonicalPath, path)))
      .map(path => [path, readFileSync(join(baseline.canonicalPath, path), 'utf8')]));
    const executor = createNodeTaskVerificationExecutor({
      processes, verification: verificationStore, atomic, artifacts: core.artifactStore, files: core.artifactFileStore,
      stopControl: core.verificationStops,
      resolveCwd: async () => baseline.canonicalPath, resolveEnvironment: () => ({}),
      confirmProcessIdentity: async identity => {
        // The real collector waits for this exact OS process and confirms stop.
        if (!identity.launchId || identity.pid < 1) throw Error('invalid checker identity');
      },
    });
    const verification = await executor.start({ projectId: attempt.project_id, featureId: attempt.feature_id,
      runId: attempt.run_id, taskId: attempt.task_id, attemptId: attempt.id, executionVersion: attempt.execution_version,
      operation: 'task.verify.checks', evidenceOperationId: randomUUID(), batchId: randomUUID(),
      codeDigest: beforeIdentity.codeDigest, policyDigest, environmentSummary: { node: process.version },
      plan: { status: 'ready', selectedChecks: [config.chain.check] }, targets: ['chain'],
      assertCurrentIdentity: async () => verificationCodeIdentity(await inspector.inspect(baseline)).codeDigest === beforeIdentity.codeDigest,
    });
    const afterIdentity = verificationCodeIdentity(await inspector.inspect(baseline), { executionDigest: policyDigest });
    const settlement = JSON.parse(await artifactText(attempt.project_id, attempt.diagnostic_ref));
    const completion = await core.taskVerificationCompletion.complete({ identity: resourceIdentity,
      taskId: attempt.task_id, runId: attempt.run_id, verificationBatchId: verification.batchId,
      observation: { runtime: { result: settlement.execution.result, stopped: settlement.stop.evidence },
        workspaceHeld: core.workResources.read(resourceIdentity).leases.length === 3,
        beforeIdentity, afterIdentity, testCounts: Object.fromEntries(verification.results.map(result => [result.checkKey, result.testCount])) },
      failures: Object.fromEntries(verification.results.filter(result => result.status === 'failed').map(result => [result.checkKey, 'code'])),
    });
    const inputText = await artifactText(attempt.project_id, attempt.input_ref);
    const outputs = [];
    for (const result of verification.results) {
      const stored = core.verificationStore.listCheckResults(attempt.project_id, verification.batchId).find(check => check.id === result.resultId);
      if (!stored?.outputArtifactId) throw Error('missing checker output');
      outputs.push(await artifactText(attempt.project_id, stored.outputArtifactId));
    }
    const afterGit = { head: git(baseline.canonicalPath, ['rev-parse', 'HEAD']),
      tree: git(baseline.canonicalPath, ['rev-parse', 'HEAD^{tree}']),
      status: git(baseline.canonicalPath, ['status', '--porcelain=v1']) };
    const finalization = attempt.task_id === 'chain-3' && completion.receipt.status === 'succeeded'
      ? await delivery.finish(attempt, baseline) : null;
    return { attemptId: attempt.id, workspaceId: workspace.id, beforeGit, afterGit, beforeFiles, beforeIdentity, afterIdentity,
      inputManifest: attempt.input_ref, inputText, verification, completion, outputs, finalization };
  }
  const timer = setInterval(() => {
    if (busy || closed) return;
    const path = join(config.chain.root, 'chain-control.json');
    if (!existsSync(path)) return;
    let control;
    try { control = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
    if (!/^[a-f0-9-]{36}$/.test(control.id) || !['chain-1', 'chain-2', 'chain-3'].includes(control.taskId) || seen.has(control.id)) return;
    seen.add(control.id);
    busy = true;
    active = verify(control).catch(error => ({ error: String(error), stack: error.stack, details: error.details })).then(result => {
      const path = join(config.chain.root, `chain-result-${control.id}.json`);
      writeFileSync(`${path}.tmp`, JSON.stringify(result));
      renameSync(`${path}.tmp`, path);
    }).finally(() => { busy = false; });
  }, 20);
  return async () => { closed = true; clearInterval(timer); await active; await delivery.close(); session.close(); };
}
