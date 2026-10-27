/**
 * P06-1 文件系统静态技术检测器。
 *
 * 适配器只做有限的目录枚举和受控清单读取。它不调用 shell/子进程，不执行
 * package scripts、未知扩展、安装器或仓库插件；输出只包含相对来源和摘要。
 */
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  DETECTION_EVIDENCE_SCHEMA_VERSION,
  PROJECT_PROFILE_DETECTOR_VERSION,
  PROJECT_PROFILE_SCHEMA_VERSION,
  createCandidateProfile,
  createDetectionEvidence,
  type DetectionEvidence,
  type DetectionKind,
  type DetectionUncertainty,
  type ProjectDetection,
  type ProjectProfileInspectionResult,
  type ProjectProfileInspector,
} from '../../ports/project-profile.js';
import { validateRepositoryInspectionPath } from '../../ports/repository-inspector.js';

const OPERATION = 'ProjectProfileInspector.inspect';
const MAX_SCAN_FILES = 2_000;
const MAX_SCAN_DEPTH = 8;
const MAX_CONTROLLED_FILE_BYTES = 1_048_576;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.shiploop',
]);
const IGNORED_EXTENSIONS = new Set([
  '',
  '.json',
  '.lock',
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.toml',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.css',
  '.scss',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.map',
  '.csproj',
]);

interface FileEntry {
  readonly relativePath: string;
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

interface DetectionDefinition {
  readonly key: string;
  readonly kind: DetectionKind;
  readonly moduleId: string;
  readonly language: string;
  readonly sources: readonly string[];
  readonly summary: string;
}

export type ProjectProfileInspectionErrorKind =
  | 'invalid_input'
  | 'not_found'
  | 'not_a_directory'
  | 'permission'
  | 'io';

export class ProjectProfileInspectionError extends Error {
  readonly kind: ProjectProfileInspectionErrorKind;
  readonly operation: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    kind: ProjectProfileInspectionErrorKind,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(`${OPERATION}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'ProjectProfileInspectionError';
    this.kind = kind;
    this.operation = OPERATION;
    this.details = details;
  }
}

export function isProjectProfileInspectionError(
  value: unknown,
  kind?: ProjectProfileInspectionErrorKind,
): value is ProjectProfileInspectionError {
  return value instanceof ProjectProfileInspectionError && (kind === undefined || value.kind === kind);
}

export type RepositoryProfileInspector = ProjectProfileInspector;

export interface ProjectProfileInspectorOptions {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
}

function mapFsError(error: unknown, reason: string): ProjectProfileInspectionError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') {
    return new ProjectProfileInspectionError('not_found', '仓库目录不存在', { reason, code }, error);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new ProjectProfileInspectionError('permission', '仓库目录或受控文件不可访问', { reason, code }, error);
  }
  return new ProjectProfileInspectionError('io', '仓库静态扫描失败', { reason, code: code ?? 'unknown' }, error);
}

function validateOptions(options: ProjectProfileInspectorOptions | undefined): Required<ProjectProfileInspectorOptions> {
  if (options === undefined) {
    return { maxFiles: MAX_SCAN_FILES, maxFileBytes: MAX_CONTROLLED_FILE_BYTES };
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ProjectProfileInspectionError('invalid_input', '装配参数必须是对象', { reason: 'options_not_object' });
  }
  for (const key of Object.keys(options)) {
    if (key !== 'maxFiles' && key !== 'maxFileBytes') {
      throw new ProjectProfileInspectionError('invalid_input', '存在未知装配参数', { reason: 'unknown_option' });
    }
  }
  const maxFiles = options.maxFiles ?? MAX_SCAN_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_CONTROLLED_FILE_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_SCAN_FILES) {
    throw new ProjectProfileInspectionError('invalid_input', 'maxFiles 超出有限范围', { reason: 'max_files_invalid' });
  }
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 128 || maxFileBytes > MAX_CONTROLLED_FILE_BYTES) {
    throw new ProjectProfileInspectionError('invalid_input', 'maxFileBytes 超出有限范围', { reason: 'max_file_bytes_invalid' });
  }
  return { maxFiles, maxFileBytes };
}

async function enumerateFiles(root: string, maxFiles: number): Promise<{
  readonly files: readonly FileEntry[];
  readonly limited: boolean;
}> {
  const files: FileEntry[] = [];
  let limited = false;
  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || limited) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, 'directory_unreadable');
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (limited) return;
      if (entry.name === '.' || entry.name === '..') continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const childRelative = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      const childPath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(childPath, childRelative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({ relativePath: childRelative, name: entry.name, isFile: true, isDirectory: false });
      if (files.length >= maxFiles) {
        limited = true;
        return;
      }
    }
  }
  await visit(root, '', 0);
  return { files, limited };
}

function fileByName(files: readonly FileEntry[], name: string): FileEntry | undefined {
  return files.find((file) => file.relativePath === name);
}

function sourceFileForExtension(files: readonly FileEntry[], extensions: readonly string[]): FileEntry | undefined {
  return files.find((file) => extensions.includes(extname(file.name).toLowerCase()));
}

async function readControlledManifest(
  root: string,
  file: FileEntry,
  maxFileBytes: number,
): Promise<{ readonly text: string } | { readonly reason: 'unreadable_file' | 'malformed_manifest'; readonly summary: string }> {
  const absolute = `${root}/${file.relativePath}`;
  try {
    const buffer = await readFile(absolute);
    if (buffer.byteLength > maxFileBytes) {
      return { reason: 'unreadable_file', summary: '受控清单超过读取上限，未确认检测结论' };
    }
    return { text: buffer.toString('utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { reason: 'unreadable_file', summary: '受控清单不可读，未确认检测结论' };
    }
    return { reason: 'unreadable_file', summary: '受控清单读取失败，未确认检测结论' };
  }
}

function uncertainty(
  reason: DetectionUncertainty['reason'],
  source: string,
  summary: string,
): DetectionUncertainty {
  return Object.freeze({
    schemaVersion: DETECTION_EVIDENCE_SCHEMA_VERSION,
    reason,
    source,
    summary,
    status: 'manual_configuration_required' as const,
  });
}

function definitionFor(key: string, source: string): DetectionDefinition {
  const definitions: Record<string, DetectionDefinition> = {
    node: { key: 'node', kind: 'runtime', moduleId: 'language-node', language: 'node', sources: [source], summary: '检测到 Node.js 项目清单或 JavaScript 源文件' },
    typescript: { key: 'typescript', kind: 'language', moduleId: 'language-typescript', language: 'typescript', sources: [source], summary: '检测到 TypeScript 配置或源文件' },
    python: { key: 'python', kind: 'language', moduleId: 'language-python', language: 'python', sources: [source], summary: '检测到 Python 项目清单或源文件' },
    rust: { key: 'rust', kind: 'language', moduleId: 'language-rust', language: 'rust', sources: [source], summary: '检测到 Rust 项目清单或源文件' },
    go: { key: 'go', kind: 'language', moduleId: 'language-go', language: 'go', sources: [source], summary: '检测到 Go 项目清单或源文件' },
    java: { key: 'java', kind: 'language', moduleId: 'language-java', language: 'java', sources: [source], summary: '检测到 Java 项目清单或源文件' },
    kotlin: { key: 'kotlin', kind: 'language', moduleId: 'language-kotlin', language: 'kotlin', sources: [source], summary: '检测到 Kotlin 项目清单或源文件' },
    ruby: { key: 'ruby', kind: 'language', moduleId: 'language-ruby', language: 'ruby', sources: [source], summary: '检测到 Ruby 项目清单或源文件' },
    csharp: { key: 'csharp', kind: 'language', moduleId: 'language-csharp', language: 'csharp', sources: [source], summary: '检测到 C# 项目清单或源文件' },
  };
  return definitions[key] ?? {
    key,
    kind: 'language',
    moduleId: `language-${key}`,
    language: key,
    sources: [source],
    summary: '检测到已知语言源文件',
  };
}

function detectionFrom(
  definition: DetectionDefinition,
  evidence: DetectionEvidence,
  status: 'candidate' | 'manual_configuration_required' = 'candidate',
): ProjectDetection {
  return Object.freeze({
    schemaVersion: DETECTION_EVIDENCE_SCHEMA_VERSION,
    id: `detection-${definition.key}`,
    key: definition.key,
    kind: definition.kind,
    status,
    confirmed: false,
    evidence: [evidence],
  });
}

function moduleReference(definition: DetectionDefinition): {
  readonly id: string;
  readonly version: string;
  readonly roots: readonly string[];
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly capabilityRefs: readonly string[];
  readonly checkRefs: readonly string[];
} {
  const version = '1.0.0';
  return {
    id: definition.moduleId,
    version,
    roots: ['.'],
    languages: [definition.language],
    frameworks: [],
    capabilityRefs: [`${definition.moduleId}@${version}`],
    checkRefs: [],
  };
}

function unknownExtension(file: FileEntry): boolean {
  const extension = extname(file.name).toLowerCase();
  return extension.length > 0 && !IGNORED_EXTENSIONS.has(extension) && ![
    '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
    '.py', '.pyi', '.rs', '.go', '.java', '.kt', '.kts', '.rb', '.cs',
  ].includes(extension);
}

function detectDefinitions(files: readonly FileEntry[], readableManifests: ReadonlySet<string>): DetectionDefinition[] {
  const results = new Map<string, DetectionDefinition>();
  const add = (key: string, source: string): void => {
    if (!results.has(key)) results.set(key, definitionFor(key, source));
  };
  const packageJson = fileByName(files, 'package.json');
  if (packageJson && readableManifests.has(packageJson.relativePath)) add('node', packageJson.relativePath);
  const nodeSource = sourceFileForExtension(files, ['.js', '.jsx', '.mjs', '.cjs']);
  if (nodeSource) add('node', nodeSource.relativePath);
  const tsconfig = fileByName(files, 'tsconfig.json');
  const tsSource = sourceFileForExtension(files, ['.ts', '.tsx', '.mts', '.cts']);
  if ((tsconfig && readableManifests.has(tsconfig.relativePath)) || tsSource) add('typescript', tsconfig?.relativePath ?? tsSource!.relativePath);
  const pythonManifest = files.find((file) => ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg'].includes(file.relativePath));
  const pythonSource = sourceFileForExtension(files, ['.py', '.pyi']);
  if (pythonManifest && readableManifests.has(pythonManifest.relativePath)) add('python', pythonManifest.relativePath);
  else if (pythonSource) add('python', pythonSource.relativePath);
  const rustManifest = fileByName(files, 'Cargo.toml');
  const rustSource = sourceFileForExtension(files, ['.rs']);
  if ((rustManifest && readableManifests.has(rustManifest.relativePath)) || rustSource) add('rust', rustManifest?.relativePath ?? rustSource!.relativePath);
  const goManifest = fileByName(files, 'go.mod');
  const goSource = sourceFileForExtension(files, ['.go']);
  if ((goManifest && readableManifests.has(goManifest.relativePath)) || goSource) add('go', goManifest?.relativePath ?? goSource!.relativePath);
  const javaManifest = files.find((file) => ['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(file.relativePath));
  const javaSource = sourceFileForExtension(files, ['.java']);
  if ((javaManifest && readableManifests.has(javaManifest.relativePath)) || javaSource) add('java', javaManifest?.relativePath ?? javaSource!.relativePath);
  const kotlinSource = sourceFileForExtension(files, ['.kt', '.kts']);
  if (kotlinSource) add('kotlin', kotlinSource.relativePath);
  const rubyManifest = fileByName(files, 'Gemfile');
  const rubySource = sourceFileForExtension(files, ['.rb']);
  if ((rubyManifest && readableManifests.has(rubyManifest.relativePath)) || rubySource) add('ruby', rubyManifest?.relativePath ?? rubySource!.relativePath);
  const csharpManifest = files.find((file) => extname(file.name).toLowerCase() === '.csproj');
  const csharpSource = sourceFileForExtension(files, ['.cs']);
  if ((csharpManifest && readableManifests.has(csharpManifest.relativePath)) || csharpSource) add('csharp', csharpManifest?.relativePath ?? csharpSource!.relativePath);
  return [...results.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** 创建延迟执行的静态仓库技术检测器。装配本身不触碰仓库。 */
export function createProjectProfileInspector(options?: ProjectProfileInspectorOptions): ProjectProfileInspector {
  const config = validateOptions(options);
  return {
    async inspect(repositoryPath: unknown): Promise<ProjectProfileInspectionResult> {
      const inputPath = validateRepositoryInspectionPath(repositoryPath, OPERATION);
      let root: string;
      try {
        root = await realpath(inputPath);
        const stat = await lstat(root);
        if (!stat.isDirectory()) {
          throw new ProjectProfileInspectionError('not_a_directory', '仓库路径不是目录', { reason: 'path_not_directory' });
        }
      } catch (error) {
        if (error instanceof ProjectProfileInspectionError) throw error;
        throw mapFsError(error, 'root_unavailable');
      }

      const { files, limited } = await enumerateFiles(root, config.maxFiles);
      const uncertainties: DetectionUncertainty[] = [];
      if (limited) uncertainties.push(uncertainty('scan_limit', 'repository-root', '仓库文件数量达到扫描上限，剩余内容需人工配置'));
      const readableManifests = new Set<string>();
      const manifestNames = new Set([
        'package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg',
        'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile',
      ]);
      for (const file of files) {
        if (!manifestNames.has(file.name) && !file.relativePath.endsWith('.csproj')) continue;
        const probe = await readControlledManifest(root, file, config.maxFileBytes);
        if ('text' in probe) {
          if (file.name === 'package.json') {
            try {
              const parsed: unknown = JSON.parse(probe.text);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('manifest shape');
            } catch {
              uncertainties.push(uncertainty('malformed_manifest', file.relativePath, 'Node.js 清单不是有效 JSON，未确认 Node.js 事实'));
              continue;
            }
          }
          readableManifests.add(file.relativePath);
        } else {
          uncertainties.push(uncertainty(probe.reason, file.relativePath, probe.summary));
        }
      }
      const unknownFiles = files.filter(unknownExtension);
      for (const file of unknownFiles) {
        uncertainties.push(uncertainty('unknown_language', file.relativePath, '发现未知扩展名，未执行或读取其内容，需人工配置语言'));
      }
      const definitions = detectDefinitions(files, readableManifests);
      if (files.length === 0) uncertainties.push(uncertainty('missing_file', 'repository-root', '仓库没有可用于静态识别的文件'));
      if (definitions.length === 0 && files.length > 0 && uncertainties.every((item) => item.reason !== 'unknown_language')) {
        uncertainties.push(uncertainty('missing_file', 'repository-root', '未发现已知技术栈清单或源文件，需人工配置'));
      }
      const evidence: DetectionEvidence[] = [];
      const detections: ProjectDetection[] = definitions.map((definition) => {
        const item = createDetectionEvidence({
          id: `evidence-${definition.key}`,
          detectorId: `static-${definition.key}`,
          detectorVersion: PROJECT_PROFILE_DETECTOR_VERSION,
          source: definition.sources[0]!,
          summary: definition.summary,
          status: 'candidate',
          confirmed: false,
        });
        evidence.push(item);
        return detectionFrom(definition, item);
      });
      if (unknownFiles.length > 0) {
        const unknownSource = unknownFiles[0]!.relativePath;
        const item = createDetectionEvidence({
          id: 'evidence-unknown-language',
          detectorId: 'static-unknown-language',
          detectorVersion: PROJECT_PROFILE_DETECTOR_VERSION,
          source: unknownSource,
          summary: '发现未登记的文件扩展名；语言候选需人工配置',
          status: 'manual_configuration_required',
          confirmed: false,
        });
        evidence.push(item);
        detections.push(
          detectionFrom(
            { ...definitionFor('unknown', unknownSource), key: 'unknown', moduleId: 'language-unknown' },
            item,
            'manual_configuration_required',
          ),
        );
      }
      const modules = definitions.map(moduleReference);
      const candidateProfile = createCandidateProfile({
        projectId: 'unassigned',
        modules,
        detectionEvidenceRefs: evidence.map((item) => item.id),
      });
      return Object.freeze({
        schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
        detectorVersion: PROJECT_PROFILE_DETECTOR_VERSION,
        detections: Object.freeze(detections),
        evidence: Object.freeze(evidence),
        uncertainties: Object.freeze(uncertainties),
        candidateProfile,
      });
    },
  };
}

export const createStaticProjectProfileInspector = createProjectProfileInspector;
export const createStaticProjectInspector = createProjectProfileInspector;
export const createRepositoryProfileInspector = createProjectProfileInspector;
