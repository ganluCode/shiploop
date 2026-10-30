import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { deriveArtifactFinalRelativePath } from '../../ports/artifact-files.js';
import { validateRestoreConfirmation, validateDataLifecycleIntent, validateDataLifecycleStep, validateDataLifecycleResult } from '../../ports/data-lifecycle.js';
import type { BackupFileEntry, RestoreConfirmation } from '../../ports/data-lifecycle.js';
import type { BackupVerificationReport } from '../../ports/backup-verification.js';
import { createBackupPackageVerificationService } from './backup-verification.js';

const JOURNAL = 'restore-operation.json';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

type Step = 'copying' | 'prepared' | 'publishing' | 'published';
export type RestoreBoundary = 'after-file-copy' | 'after-copy' | 'before-publish' | 'after-publish-group' | 'after-publish';
interface Intent {
  schemaVersion: 1;
  operationId: string;
  targetIdentity: string;
  backupId: string;
  manifestDigest: string;
  reportDigest: string;
  nonce: string;
  files: readonly BackupFileEntry[];
  step: Step;
  stagingRelativePath: string | null;
  activated: boolean;
}
export interface RestorePreview {
  readonly operationId: string;
  readonly backupId: string;
  readonly targetIdentity: string;
  readonly manifestDigest: string;
  readonly reportDigest: string;
  readonly confirmation: RestoreConfirmation;
  readonly status: 'prepared';
}
export interface RestoreReceipt {
  readonly operationId: string;
  readonly backupId: string;
  readonly targetIdentity: string;
  readonly manifestDigest: string;
  readonly reportDigest: string;
  readonly status: 'published';
  readonly execution: 'blocked_pending_current_repository_and_stop_checks';
  readonly cleanup: 'retained';
}
export interface DataRestoreServiceOptions {
  readonly dataRoot: string;
  /** The trusted Host assembly must hold the existing data-root writer lock for the whole callback. */
  readonly withWriterLock: <T>(action: () => Promise<T>) => Promise<T>;
  /** Trusted fault barrier, never a request, environment or CLI option. */
  readonly boundary?: (point: RestoreBoundary) => Promise<void>;
}
export interface DataRestoreService {
  prepare(input: { readonly operationId: string; readonly packagePath: string }): Promise<RestorePreview>;
  confirm(input: { readonly operationId: string; readonly confirmation: unknown }): Promise<RestoreReceipt>;
}

function fail(reason: string): never { throw new Error(`data.restore: ${reason}`); }
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}`;
}
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
function identity(root: string): string {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) fail('target_drift');
  return hash(stable([root, stat.dev, stat.ino]));
}
function sync(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function safeDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_directory');
}
function safeFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('unsafe_file');
}
function save(root: string, intent: Intent): void {
  const stagingRoot = join(root, 'restore-staging');
  safeDirectory(stagingRoot);
  const temporary = join(stagingRoot, `.restore-${randomUUID()}.tmp`);
  const lifecycleIntent = validateDataLifecycleIntent({ schemaVersion: 1, operationId: intent.operationId,
    kind: 'restore', targetId: intent.targetIdentity, intentDigest: token(intent) });
  const lifecycleStep = validateDataLifecycleStep({ schemaVersion: 1, operationId: intent.operationId,
    step: intent.step, status: intent.step === 'published' ? 'completed' : 'running' });
  const lifecycleResult = intent.step === 'published' ? validateDataLifecycleResult({ schemaVersion: 1,
    operationId: intent.operationId, status: 'completed', resultDigest: hash(stable(summary(intent))) }) : null;
  writeFileSync(temporary, JSON.stringify({ ...intent, lifecycleIntent, lifecycleStep, lifecycleResult }), { flag: 'wx', mode: 0o600 });
  sync(temporary);
  renameSync(temporary, join(root, JOURNAL));
  sync(stagingRoot);
  sync(root);
}
function read(root: string): Intent | null {
  const path = join(root, JOURNAL);
  if (!existsSync(path)) return null;
  safeFile(path);
  const intent = JSON.parse(readFileSync(path, 'utf8')) as Intent;
  if (intent.schemaVersion !== 1 || !ID.test(intent.operationId) || !ID.test(intent.backupId)
    || !HASH.test(intent.targetIdentity) || !HASH.test(intent.manifestDigest) || !HASH.test(intent.reportDigest)
    || typeof intent.nonce !== 'string' || !ID.test(intent.nonce) || typeof intent.activated !== 'boolean'
    || !['copying', 'prepared', 'publishing', 'published'].includes(intent.step)
    || !Array.isArray(intent.files) || intent.files.length === 0
    || (intent.stagingRelativePath !== null && !/^restore-staging\/[A-Za-z0-9._:-]+$/.test(intent.stagingRelativePath))) fail('intent_corrupt');
  const names = new Set<string>();
  for (const entry of intent.files) {
    // Authentication/discovery, worktrees, source registrations and arbitrary paths are never restored.
    if (!(entry.logicalPath === 'core.sqlite' || /^artifacts\/[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(entry.logicalPath))
      || !HASH.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || names.has(entry.logicalPath)) fail('intent_files_invalid');
    names.add(entry.logicalPath);
  }
  if (!names.has('core.sqlite')) fail('intent_database_missing');
  if (intent.targetIdentity !== identity(root)) fail('target_drift');
  return intent;
}
function token(intent: Intent): string {
  return hash(stable({ operationId: intent.operationId, targetIdentity: intent.targetIdentity, backupId: intent.backupId,
    manifestDigest: intent.manifestDigest, reportDigest: intent.reportDigest, nonce: intent.nonce, files: intent.files }));
}
function confirmationFor(intent: Intent): RestoreConfirmation {
  return validateRestoreConfirmation({ schemaVersion: 1, backupId: intent.backupId, manifestDigest: intent.manifestDigest,
    verificationDigest: intent.reportDigest, targetDataRootId: intent.targetIdentity, targetMode: 'empty-isolated', confirmed: true });
}
function summary(intent: Intent) {
  return { operationId: intent.operationId, backupId: intent.backupId, targetIdentity: intent.targetIdentity,
    manifestDigest: intent.manifestDigest, reportDigest: intent.reportDigest };
}
function reportDigest(report: BackupVerificationReport): string {
  const { durationMs: _duration, ...facts } = report;
  return hash(stable(facts));
}
function publicationFiles(files: readonly BackupFileEntry[]): readonly BackupFileEntry[] {
  return files.map(file => {
    if (file.logicalPath === 'core.sqlite') return file;
    const [, projectId, artifactId] = file.logicalPath.split('/');
    return { ...file, logicalPath: deriveArtifactFinalRelativePath({ projectId: projectId!, artifactId: artifactId! }) };
  });
}
function checkBytes(root: string, files: readonly BackupFileEntry[], flush = false): void {
  const expected = new Set(files.map(entry => entry.logicalPath));
  for (const entry of files) {
    let path = root;
    for (const segment of entry.logicalPath.split('/')) {
      path = join(path, segment);
      if (lstatSync(path).isSymbolicLink()) fail('unsafe_file');
    }
    safeFile(path);
    if (lstatSync(path).size !== entry.sizeBytes || hash(readFileSync(path)) !== entry.sha256) fail('content_drift');
    if (flush) sync(path);
  }
  const walk = (path: string, logical: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail('unsafe_file');
    if (stat.isDirectory()) {
      if (![...expected].some(name => name.startsWith(`${logical}/`))) fail('unexpected_data');
      for (const name of readdirSync(path)) walk(join(path, name), `${logical}/${name}`);
      if (flush) sync(path);
    } else if (!expected.has(logical)) fail('unexpected_data');
  };
  for (const group of new Set(files.map(entry => entry.logicalPath.split('/')[0]!))) walk(join(root, group), group);
  if (flush) sync(root);
}
function checkRoot(root: string, intent: Intent | null): void {
  const allowed = new Set(['host', JOURNAL, 'restore-staging']);
  if (intent?.step === 'publishing' || intent?.step === 'published') {
    for (const file of publicationFiles(intent.files)) allowed.add(file.logicalPath.split('/')[0]!);
  }
  for (const name of readdirSync(root)) {
    if (!allowed.has(name)) fail('target_not_empty');
    if (name === 'restore-staging') safeDirectory(join(root, name));
  }
  const host = join(root, 'host');
  if (existsSync(host)) {
    safeDirectory(host);
    if (readdirSync(host).some(name => name !== 'writer.lock')) fail('target_host_identity_present');
  }
}

/** Read during Core opening, before SQLite/migrations; also used by direct trusted Core embedding. */
export function inspectDataRestoreState(root: string): { readonly isolated: boolean } {
  const intent = read(root);
  if (intent === null) return { isolated: false };
  if (intent.step !== 'published') fail('restore_incomplete');
  if (!intent.activated) {
    checkRoot(root, intent);
    checkBytes(root, publicationFiles(intent.files));
  }
  return { isolated: true };
}

/** Called under the same writer lock before the first Core connection is opened. */
export function activateDataRestore(root: string): void {
  const intent = read(root);
  if (intent === null || intent.activated) return;
  inspectDataRestoreState(root);
  save(root, { ...intent, activated: true });
}

export function createDataRestoreService(options: DataRestoreServiceOptions): DataRestoreService {
  if (!isAbsolute(options.dataRoot) || options.dataRoot.includes('\0')) fail('invalid_data_root');
  const root = realpathSync(options.dataRoot);
  const targetIdentity = identity(root);
  const assertRoot = () => { if (realpathSync(options.dataRoot) !== root || identity(root) !== targetIdentity) fail('target_drift'); };
  return Object.freeze({
    prepare(input: Parameters<DataRestoreService['prepare']>[0]): Promise<RestorePreview> {
      return options.withWriterLock(async () => {
        assertRoot();
        if (!ID.test(input.operationId)) fail('invalid_operation_id');
        let intent = read(root);
        if (intent !== null && intent.operationId !== input.operationId) fail('another_restore_operation');
        if (intent?.activated || intent?.step === 'publishing' || intent?.step === 'published') fail('restore_already_confirmed');
        checkRoot(root, intent);
        safeDirectory(join(root, 'restore-staging'));
        const verifier = createBackupPackageVerificationService({ dataRoot: root });
        const report = await verifier.verify({ packagePath: input.packagePath });
        if (report.status !== 'complete' || report.manifest === undefined || report.manifestDigest === null || report.backupId === null) fail('backup_not_verified');
        const digest = reportDigest(report);
        if (intent !== null && (intent.manifestDigest !== report.manifestDigest || intent.reportDigest !== digest || intent.backupId !== report.backupId)) fail('backup_identity_drift');
        if (intent === null) {
          intent = { schemaVersion: 1, operationId: input.operationId, targetIdentity, backupId: report.backupId,
            manifestDigest: report.manifestDigest, reportDigest: digest, nonce: randomUUID(), files: report.manifest.files,
            step: 'copying', stagingRelativePath: null, activated: false };
          save(root, intent);
          // Validate persisted path policy before any copy/publication.
          read(root);
        }
        if (intent.stagingRelativePath === null) {
          const staged = await verifier.stage({ packagePath: input.packagePath, verification: report });
          if (staged.status !== 'complete' || staged.stagingRelativePath === undefined) fail('staging_failed');
          if (staged.manifestDigest !== intent.manifestDigest) fail('backup_identity_drift');
          const publicationPath = `restore-staging/publish-${randomUUID()}`;
          const publicationRoot = join(root, publicationPath);
          safeDirectory(publicationRoot);
          const mapped = publicationFiles(intent.files);
          for (let index = 0; index < intent.files.length; index++) {
            const source = join(root, staged.stagingRelativePath, intent.files[index]!.logicalPath);
            const destination = join(publicationRoot, mapped[index]!.logicalPath);
            const segments = mapped[index]!.logicalPath.split('/');
            let parent = publicationRoot;
            for (const segment of segments.slice(0, -1)) { parent = join(parent, segment); safeDirectory(parent); }
            safeFile(source);
            copyFileSync(source, destination, constants.COPYFILE_EXCL);
            sync(destination);
            await options.boundary?.('after-file-copy');
          }
          checkBytes(publicationRoot, mapped, true);
          intent = { ...intent, stagingRelativePath: publicationPath };
          save(root, intent);
        }
        checkBytes(join(root, intent.stagingRelativePath!), publicationFiles(intent.files), true);
        await options.boundary?.('after-copy');
        assertRoot(); checkRoot(root, intent);
        intent = { ...intent, step: 'prepared' };
        save(root, intent);
        return { ...summary(intent), status: 'prepared', confirmation: confirmationFor(intent) };
      });
    },
    confirm(input: Parameters<DataRestoreService['confirm']>[0]): Promise<RestoreReceipt> {
      return options.withWriterLock(async () => {
        assertRoot();
        let intent = read(root);
        let confirmation: RestoreConfirmation;
        try { confirmation = validateRestoreConfirmation(input.confirmation); } catch { fail('confirmation_mismatch'); }
        if (intent === null || intent.operationId !== input.operationId
          || stable(confirmation) !== stable(confirmationFor(intent))) fail('confirmation_mismatch');
        if (intent.step === 'copying' || intent.stagingRelativePath === null) fail('staging_not_prepared');
        if (intent.activated) fail('target_already_activated');
        checkRoot(root, intent);
        const filesToPublish = publicationFiles(intent.files);
        const staging = join(root, intent.stagingRelativePath);
        safeDirectory(staging);
        if (intent.step === 'prepared') {
          checkBytes(staging, filesToPublish, true);
          intent = { ...intent, step: 'publishing' };
          save(root, intent);
        }
        if (intent.step === 'publishing') {
          await options.boundary?.('before-publish');
          assertRoot(); checkRoot(root, intent);
          // Publish whole top-level groups, DB last. An interrupted rename is reconciled
          // by bytes on disk; a present target is never overwritten or merged.
          const groups = [...new Set(filesToPublish.map(file => file.logicalPath.split('/')[0]!))]
            .sort((a, b) => a === 'core.sqlite' ? 1 : b === 'core.sqlite' ? -1 : a.localeCompare(b));
          for (const group of groups) {
            const files = filesToPublish.filter(file => file.logicalPath.split('/')[0] === group);
            const destination = join(root, group);
            const source = join(staging, group);
            if (existsSync(destination)) {
              if (existsSync(source)) fail('publication_collision');
              checkBytes(root, files);
            } else {
              checkBytes(staging, files, true);
              renameSync(source, destination);
              sync(staging); sync(root);
              await options.boundary?.('after-publish-group');
            }
          }
          checkBytes(root, filesToPublish);
          await options.boundary?.('after-publish');
          assertRoot();
          intent = { ...intent, step: 'published' };
          save(root, intent);
        }
        checkBytes(root, filesToPublish);
        return { ...summary(intent), status: 'published', execution: 'blocked_pending_current_repository_and_stop_checks', cleanup: 'retained' };
      });
    },
  });
}
