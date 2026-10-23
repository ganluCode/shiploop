/** Explicitly authorized, standalone standard-SDK live probe. Never part of offline acceptance. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess } from './p02-accept.ts';

export interface P04LiveApproval {
  schemaVersion: 1;
  authorization: { approved: true; id: string; expiresAt: number };
  provider: string;
  model: string;
  /** Explicit non-secret descriptor; never discovers global models.json or loads extensions. */
  customModel?: { api: 'openai-responses'; baseUrl: string; contextWindow: number; maxTokens: number;
    reasoning: boolean; supportsDeveloperRole: boolean };
  authentication: { kind: 'environment'; sourceRef: string; variable: string };
  repository: string;
  expectedCommit: string;
  resources: ['read_greeting', 'write_greeting'];
  fallback: [];
  budgets: { maxAttempts: 1; maxRequests: number; timeoutMs: number; maxInputTokens: number; maxOutputTokens: number; maxTokens: number };
  scenario: 'change' | 'cancel' | 'resume-required';
  cancelAfterMs?: number;
  reportDir: string;
}
export interface P04LiveResult {
  exitCode: number;
  status: 'not_run' | 'pass' | 'partial' | 'fail';
  /** null means the Runner did not return a trustworthy admission count. */
  realCalls: number | null;
  reason: string;
  reportDir: string | null;
}
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
const positive = (n: unknown, max: number): n is number => Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= max;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function reject(): never { throw new Error('live_input_rejected'); }
function noLinks(path: string): void {
  for (let p = resolve(path); ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) reject();
    if (dirname(p) === p) break;
  }
}
function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
export function validateP04LiveApproval(raw: unknown, reportDirectoryCreated = false): P04LiveApproval {
  if (!raw || typeof raw !== 'object') reject();
  const a = raw as P04LiveApproval;
  if (a.schemaVersion !== 1 || a.authorization?.approved !== true || !token(a.authorization.id)
      || !Number.isSafeInteger(a.authorization.expiresAt) || a.authorization.expiresAt <= Date.now()) reject();
  if (!token(a.provider) || !token(a.model) || a.authentication?.kind !== 'environment'
      || !token(a.authentication.sourceRef) || !/^[A-Z][A-Z0-9_]{2,100}$/.test(a.authentication.variable)) reject();
  if (JSON.stringify(a.resources) !== JSON.stringify(['read_greeting', 'write_greeting'])
      || !Array.isArray(a.fallback) || a.fallback.length !== 0) reject();
  const b = a.budgets;
  if (!b || b.maxAttempts !== 1 || !positive(b.maxRequests, 5) || !positive(b.timeoutMs, 120_000)
      || !positive(b.maxInputTokens, 32_000) || !positive(b.maxOutputTokens, 4096) || !positive(b.maxTokens, 180_000)
      || b.maxTokens < b.maxInputTokens + b.maxOutputTokens) reject();
  let customModel: P04LiveApproval['customModel'];
  if (a.customModel !== undefined) {
    const c = a.customModel;
    const keys = ['api', 'baseUrl', 'contextWindow', 'maxTokens', 'reasoning', 'supportsDeveloperRole'];
    if (!c || typeof c !== 'object' || Object.keys(c).length !== keys.length
        || Object.keys(c).some(key => !keys.includes(key)) || c.api !== 'openai-responses'
        || typeof c.baseUrl !== 'string' || c.baseUrl.length > 2048
        || typeof c.reasoning !== 'boolean' || typeof c.supportsDeveloperRole !== 'boolean'
        || !positive(c.contextWindow, 2_000_000) || !positive(c.maxTokens, 100_000)
        || c.maxTokens < b.maxOutputTokens || c.contextWindow < b.maxInputTokens + b.maxOutputTokens) reject();
    const url = new URL(c.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || url.port || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
        || url.hostname.endsWith('.local') || !url.hostname.includes('.') || isIP(url.hostname)
        || url.hostname.startsWith('[')) reject();
    customModel = { api: c.api, baseUrl: url.href.replace(/\/$/, ''), contextWindow: c.contextWindow,
      maxTokens: c.maxTokens, reasoning: c.reasoning, supportsDeveloperRole: c.supportsDeveloperRole };
  }
  if (!['change', 'cancel', 'resume-required'].includes(a.scenario)) reject();
  if (a.scenario === 'cancel' && (!positive(a.cancelAfterMs, b.timeoutMs - 1))) reject();
  if (typeof a.repository !== 'string' || !isAbsolute(a.repository) || typeof a.reportDir !== 'string' || !isAbsolute(a.reportDir)
      || !/^[a-f0-9]{40}$/.test(a.expectedCommit)) reject();
  noLinks(a.repository); noLinks(a.reportDir);
  const repo = realpathSync(a.repository), temp = realpathSync(tmpdir());
  if (!relative(temp, repo) || relative(temp, repo).startsWith('..') || !lstatSync(join(repo, '.git')).isDirectory()) reject();
  if (git(repo, ['rev-parse', '--show-toplevel']) !== repo || git(repo, ['rev-parse', 'HEAD']) !== a.expectedCommit
      || git(repo, ['status', '--porcelain']) !== '' || git(repo, ['remote']) !== ''
      || git(repo, ['ls-files']) !== 'greeting.txt') reject();
  const target = join(repo, 'greeting.txt');
  if (lstatSync(target).isSymbolicLink() || readFileSync(target, 'utf8') !== 'hello\n') reject();
  if ((!reportDirectoryCreated && existsSync(a.reportDir)) || resolve(a.reportDir) === repo
      || !relative(repo, resolve(a.reportDir)).startsWith('..') || !relative(resolve(a.reportDir), repo).startsWith('..')) reject();
  // Copy only supported fields: arbitrary JSON properties never reach the SDK or snapshots.
  return { schemaVersion: 1, authorization: { approved: true, id: a.authorization.id, expiresAt: a.authorization.expiresAt }, provider: a.provider, model: a.model,
    ...(customModel === undefined ? {} : { customModel }),
    authentication: { kind: 'environment', sourceRef: a.authentication.sourceRef, variable: a.authentication.variable },
    repository: repo, expectedCommit: a.expectedCommit, resources: ['read_greeting', 'write_greeting'], fallback: [],
    budgets: { maxAttempts: 1, maxRequests: b.maxRequests, timeoutMs: b.timeoutMs, maxInputTokens: b.maxInputTokens,
      maxOutputTokens: b.maxOutputTokens, maxTokens: b.maxTokens }, scenario: a.scenario,
    ...(a.scenario === 'cancel' ? { cancelAfterMs: a.cancelAfterMs } : {}), reportDir: resolve(a.reportDir) };
}
/** Conservatively reserve a full input/output allowance before each SDK request. Unknown usage never refunds it. */
export function createP04LiveBudget(a: P04LiveApproval, now: () => number = Date.now) {
  const deadline = now() + a.budgets.timeoutMs;
  let requests = 0, reservedTokens = 0;
  return {
    admit(provider: string, model: string, context: unknown) {
      const amount = a.budgets.maxInputTokens + a.budgets.maxOutputTokens;
      if (provider !== a.provider || model !== a.model || now() >= deadline || now() >= a.authorization.expiresAt
          || requests >= a.budgets.maxRequests || reservedTokens + amount > a.budgets.maxTokens
          || Buffer.byteLength(JSON.stringify(context)) + 4096 > a.budgets.maxInputTokens) throw new Error('live_budget_or_strategy_rejected');
      requests++; reservedTokens += amount;
      return a.budgets.maxOutputTokens;
    },
    snapshot: () => ({ requests, reservedTokens, deadline }),
  };
}
export function redactP04Live(value: unknown, secrets: readonly string[]): string {
  let text = JSON.stringify(value, null, 2);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const form of [secret, JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString('base64'), encodeURIComponent(secret)]) text = text.split(form).join('[REDACTED]');
  }
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]') + '\n';
}

export async function runP04Live(options: { approvalFile?: string; environment?: NodeJS.ProcessEnv;
  runProcess?: typeof runBoundedProcess } = {}): Promise<P04LiveResult> {
  let a: P04LiveApproval, secret: string;
  try {
    if (!options.approvalFile) reject();
    noLinks(options.approvalFile!);
    const approvalStat = lstatSync(options.approvalFile!);
    if (!approvalStat.isFile() || approvalStat.size > 65_536) reject();
    a = validateP04LiveApproval(JSON.parse(readFileSync(options.approvalFile!, 'utf8')));
    secret = (options.environment ?? process.env)[a.authentication.variable] ?? '';
    if (!secret.trim() || secret.length > 16_384 || JSON.stringify(a).includes(secret)) reject();
  } catch { return { exitCode: 2, status: 'not_run', realCalls: 0, reason: 'authorization_or_input_missing_invalid', reportDir: null }; }
  // Admission is complete. No local credential discovery or automatic approval creation.
  mkdirSync(a.reportDir, { recursive: true, mode: 0o700 });
  const identity = { runId: randomUUID(), taskId: 'p04-live-small-change', attemptId: randomUUID() };
  const save = (name: string, value: unknown) => writeFileSync(join(a.reportDir, name), redactP04Live(value, [secret, a.repository]), { mode: 0o600, flag: 'wx' });
  const agentDir = join(a.reportDir, 'agent'); mkdirSync(agentDir, { mode: 0o700 });
  const prompt = 'Read greeting.txt using read_greeting, then use write_greeting to change it from hello to hello pi followed by a newline. Do not change any other file. Give a brief final response.';
  const input = { approval: a, identity, prompt };
  // Private Runner input contains approved references and paths, never credentials. Do not publish this file.
  const inputPath = join(a.reportDir, 'runner-input.json');
  writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
  const executionMode = options.runProcess ? 'fake' : 'live';
  save('input-manifest.json', { schemaVersion: 1, executionMode, scope: 'standalone-sdk-probe', identity,
    authorization: a.authorization, provider: a.provider, model: a.model, customModel: a.customModel,
    authentication: { kind: 'environment', sourceRef: a.authentication.sourceRef },
    resources: a.resources, fallback: a.fallback, budgets: a.budgets, scenario: a.scenario,
    expectedCommit: a.expectedCommit, authorizationDigest: hash(JSON.stringify(a)),
    prompt, promptHash: hash(prompt), coreBusinessAcceptance: 'not_run' });
  save('state.json', { status: 'running', identity, realCalls: null, recording: 'partial' });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C', HOME: agentDir, TMPDIR: tmpdir(),
    PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: agentDir, XDG_CACHE_HOME: agentDir,
    SHIPLOOP_P04_LIVE_KEY: secret, NO_COLOR: '1' };
  const runner = fileURLToPath(new URL('./p04-live-runner.ts', import.meta.url));
  const processResult = await (options.runProcess ?? runBoundedProcess)(process.execPath, [runner, inputPath], {
    cwd: a.repository, env, timeoutMs: a.budgets.timeoutMs, maxOutputBytes: 1_000_000 });
  // Arbitrary child stderr is deliberately not persisted. The child writes only curated, redacted evidence.
  let evidence: Record<string, any> | null = null;
  try { evidence = JSON.parse(readFileSync(join(a.reportDir, 'runner-result.json'), 'utf8')); } catch { /* crash: admission and usage unknown */ }
  const valid = evidence?.schemaVersion === 1 && evidence?.executionMode === 'live' && evidence?.identity?.attemptId === identity.attemptId
    && evidence.provider === a.provider && evidence.model === a.model
    && Number.isSafeInteger(evidence.realCalls) && evidence.realCalls >= 0 && evidence.realCalls <= a.budgets.maxRequests;
  let status: P04LiveResult['status'] = 'partial', reason = 'runner_evidence_or_stop_unknown';
  let deliveredCommit: string | null = null;
  let check: { exitCode: number | null; stoppedVerified: boolean } | null = null;
  const stopped = processResult.stoppedVerified && valid && evidence!.stopped === true;
  // The durable event prefix must exist and bind each record to this Attempt before delivery.
  let eventsVerified = false;
  try {
    const lines = readFileSync(join(a.reportDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    eventsVerified = valid && lines.length === evidence!.finalSequence && lines.every((event, index) => event.sequence === index + 1 && event.attemptId === identity.attemptId)
      && lines.some(event => event.value.type === 'model_request_admitted')
      && lines.filter(event => event.value.type === 'provider_request_started').length === evidence!.realCalls
      && lines.some(event => event.value.type === 'tool_completed' && event.value.name === 'write_greeting')
      && lines.some(event => event.value.type === 'assistant_completed');
  } catch { /* Missing, truncated, or mismatched prefix cannot authorize delivery. */ }
  if (stopped && processResult.exitCode === 0 && !processResult.stdoutTruncated && !processResult.stderrTruncated) {
    if (a.scenario === 'change' && eventsVerified && evidence!.terminal === 'completed' && evidence!.realCalls > 0) {
      try {
        // An independent, fixed check, with no provider credential in its environment or argv.
        const checked = await (options.runProcess ?? runBoundedProcess)(process.execPath,
          ['-e', "const fs=require('node:fs'); if(fs.readFileSync('greeting.txt','utf8')!=='hello pi\\n')process.exit(1)"],
          { cwd: a.repository, env: { PATH: process.env.PATH }, timeoutMs: 5000, maxOutputBytes: 4096 });
        check = { exitCode: checked.exitCode, stoppedVerified: checked.stoppedVerified };
        if (checked.exitCode !== 0 || !checked.stoppedVerified || git(a.repository, ['rev-parse', 'HEAD']) !== a.expectedCommit
            || git(a.repository, ['diff', '--name-only']) !== 'greeting.txt' || git(a.repository, ['ls-files', '--others', '--exclude-standard']) !== '') throw new Error('check_failed');
        git(a.repository, ['add', '--', 'greeting.txt']);
        git(a.repository, ['-c', 'user.name=ShipLoop live acceptance', '-c', 'user.email=live@shiploop.invalid', 'commit', '-m', 'chore(p04): 真实 Pi 小改动验收']);
        deliveredCommit = git(a.repository, ['rev-parse', 'HEAD']);
        if (git(a.repository, ['status', '--porcelain']) !== '' || git(a.repository, ['rev-parse', 'HEAD^']) !== a.expectedCommit) throw new Error('delivery_failed');
        status = 'pass'; reason = 'small_change_checked_and_delivered';
      } catch { status = 'fail'; reason = 'independent_check_or_delivery_failed'; }
    } else if (a.scenario === 'resume-required' && evidence!.terminal === 'unsupported' && evidence!.realCalls === 0) {
      status = 'partial'; reason = 'same_task_resume_unsupported_zero_call';
    } else { status = 'partial'; reason = evidence!.terminal === 'cancelled' ? 'cancelled_partial_usage' : 'live_incomplete'; }
  }
  const result: P04LiveResult = { exitCode: status === 'pass' ? 0 : 1, status, realCalls: valid ? evidence!.realCalls : null, reason, reportDir: a.reportDir };
  save('report.json', { schemaVersion: 1, executionMode, ...result, identity, provider: a.provider, model: a.model,
    runner: { exitCode: processResult.exitCode, kind: processResult.kind, stoppedVerified: processResult.stoppedVerified },
    stopped: stopped ? 'confirmed' : 'unknown', check, deliveredCommit,
    usage: valid ? evidence!.usage ?? null : null, usageCoverage: valid ? evidence!.usageCoverage ?? 'unknown' : 'unknown',
    recording: valid ? evidence!.recording ?? 'partial' : 'partial', coreBusinessAcceptance: 'not_run', phaseAccepted: false,
    scenarios: { change: a.scenario === 'change' ? status : 'not_run', cancellation: a.scenario === 'cancel' ? 'partial' : 'not_run',
      sameTaskResume: a.scenario === 'resume-required' ? 'unsupported' : 'not_run', externalToolProcesses: 'not_run' } });
  const files = ['input-manifest.json', 'state.json', 'events.jsonl', 'runner-result.json', 'report.json']
    .filter(name => existsSync(join(a.reportDir, name))).map(name => {
      const content = readFileSync(join(a.reportDir, name), 'utf8');
      return { path: name, sha256: hash(content), sizeBytes: Buffer.byteLength(content) };
    });
  save('evidence-index.json', { schemaVersion: 1, executionMode, identity, files, phaseAccepted: false });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('usage: accept:p04:live --approval <private-approval.json>');
  } else if (args.length !== 2 || args[0] !== '--approval') {
    console.log(JSON.stringify({ status: 'not_run', realCalls: 0, reason: 'explicit_approval_required' })); process.exitCode = 2;
  } else {
    try { const result = await runP04Live({ approvalFile: args[1] }); console.log(JSON.stringify(result)); process.exitCode = result.exitCode; }
    catch { console.log(JSON.stringify({ status: 'partial', realCalls: null, reason: 'evidence_write_or_process_failure' })); process.exitCode = 1; }
  }
}
