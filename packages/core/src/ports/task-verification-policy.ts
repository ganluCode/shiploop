/**
 * F-001 用户确认的 Task 检查政策（当前 settings payload 的不可变 JSON 形态）。
 *
 * 该模块只做 JSON 边界校验，不执行命令、不解析仓库路径，也不读取 Artifact。
 * 配置写入复用 settings 的 CAS/授权/回执事务；执行输入准备会把经校验的
 * verification 段复制到不可变 input snapshot，因此后续策略更新不会漂移已有执行依据。
 */
import { StorageError } from './errors.js';
import {
  isPlainObject,
  rejectUnknownKeys,
  requirePlainObject,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export const TASK_CHECK_TIMEOUT_MIN_MS = 1;
export const TASK_CHECK_TIMEOUT_MAX_MS = 3_600_000;
export const TASK_CHECK_DEFINITIONS_MAX_COUNT = 128;
export const TASK_CHECK_MODULES_MAX_COUNT = 128;
export const TASK_CHECK_TARGETS_MAX_COUNT = 256;
export const TASK_CHECK_REQUIREMENT_REFS_MAX_COUNT = 64;

export type TaskCheckScope = 'task' | 'module' | 'project';
export type TaskCheckKind = 'command';

export interface CheckDefinition {
  /** 项目内稳定身份；候选与 fallback 只能引用该键。 */
  readonly checkKey: string;
  readonly scope: TaskCheckScope;
  readonly kind: TaskCheckKind;
  /** argv 是参数数组，永不作为 shell 文本解释。 */
  readonly argv: readonly string[];
  /** 仓库内相对目录；null 表示 worktree 根。 */
  readonly cwdRef: string | null;
  /** 非敏感环境允许列表引用；null 表示最小环境。 */
  readonly environmentRef: string | null;
  /** 有界毫秒数。 */
  readonly timeout: number;
  readonly required: boolean;
  /** 项目内需求/验收身份引用。 */
  readonly requirementRefs: readonly string[];
}

export interface VerificationModuleDefinition {
  /** 项目内稳定模块身份。 */
  readonly moduleKey: string;
  /** 局部候选允许使用的仓库内目标。 */
  readonly allowedTargets: readonly string[];
  /** 该模块可能影响的逻辑范围。 */
  readonly impactScope: readonly string[];
  /** 变更时必须触发全量回退的共享高风险文件。 */
  readonly sharedHighRiskFiles: readonly string[];
}

export interface VerificationFullFallback {
  /** 全量模式必须启动的已确认检查身份。 */
  readonly checkRefs: readonly string[];
  /** 可选的全量覆盖模块身份；存在时必须引用已确认模块。 */
  readonly moduleRefs?: readonly string[];
}

export interface ConfirmedTaskVerificationPolicy {
  readonly requireChecksBeforeDone?: boolean;
  readonly checkDefinitions?: readonly CheckDefinition[];
  readonly modules?: readonly VerificationModuleDefinition[];
  readonly fullFallback?: VerificationFullFallback;
}

const POLICY_KEYS = ['requireChecksBeforeDone', 'checkDefinitions', 'modules', 'fullFallback'] as const;
const CHECK_KEYS = [
  'checkKey',
  'scope',
  'kind',
  'argv',
  'cwdRef',
  'environmentRef',
  'timeout',
  'required',
  'requirementRefs',
] as const;
const MODULE_KEYS = ['moduleKey', 'allowedTargets', 'impactScope', 'sharedHighRiskFiles'] as const;
const FALLBACK_KEYS = ['checkRefs', 'moduleRefs'] as const;
const CHECK_SCOPES = new Set<TaskCheckScope>(['task', 'module', 'project']);
const SAFE_REFERENCE_MAX_LENGTH = 256;
const MAX_TARGET_LENGTH = 1024;
const CHECK_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;

function fieldError(context: ValidationContext, field: string, reason: string, received?: unknown): StorageError {
  return validationError(context, field, reason, received);
}

function validateCheckKey(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || !CHECK_KEY_PATTERN.test(value)) {
    throw fieldError(context, field, '必须是小写稳定检查身份（^[a-z][a-z0-9._-]{0,127}$）', value);
  }
  return value;
}

function validateReference(value: unknown, context: ValidationContext, field: string): string {
  const reference = validateStableId(value, context, field);
  if (reference.length > SAFE_REFERENCE_MAX_LENGTH) {
    throw fieldError(context, field, `引用长度不得超过 ${SAFE_REFERENCE_MAX_LENGTH}`);
  }
  return reference;
}

function validatePathReference(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TARGET_LENGTH) {
    throw fieldError(context, field, `必须是 1..${MAX_TARGET_LENGTH} 字符的相对路径/目标`, value);
  }
  if (value.includes('\0') || value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) {
    throw fieldError(context, field, '必须是仓库内相对目标，不允许绝对路径或 NUL', value);
  }
  if (value.includes('\\')) {
    throw fieldError(context, field, '必须使用 POSIX 相对路径，不允许反斜杠', value);
  }
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw fieldError(context, field, '不允许空段、. 或 ..（目标必须保持在仓库内）', value);
  }
  return value;
}

function validateStringList(
  value: unknown,
  context: ValidationContext,
  field: string,
  options: { readonly min: number; readonly max: number; readonly path: boolean },
): string[] {
  if (!Array.isArray(value) || value.length < options.min || value.length > options.max) {
    throw fieldError(context, field, `必须是 ${options.min}..${options.max} 项字符串数组`, value);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemField = `${field}[${index}]`;
    const normalized = options.path
      ? validatePathReference(item, context, itemField)
      : validateReference(item, context, itemField);
    if (seen.has(normalized)) {
      throw fieldError(context, itemField, '实体内不允许重复身份', item);
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function validateNullableRef(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > SAFE_REFERENCE_MAX_LENGTH || /[\0-\x1f\x7f]/.test(value)) {
    throw fieldError(context, field, '必须是 null 或有界非空引用字符串', value);
  }
  return value;
}

function validateArgv(value: unknown, context: ValidationContext, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fieldError(context, field, '必须是非空 argv 字符串数组（不使用 shell）', value);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0 || item.includes('\0')) {
      throw fieldError(context, `${field}[${index}]`, '参数必须是非空字符串且不得包含 NUL', item);
    }
    return item;
  });
}

function validateTimeout(value: unknown, context: ValidationContext, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < TASK_CHECK_TIMEOUT_MIN_MS ||
    value > TASK_CHECK_TIMEOUT_MAX_MS
  ) {
    throw fieldError(
      context,
      field,
      `必须是 ${TASK_CHECK_TIMEOUT_MIN_MS}..${TASK_CHECK_TIMEOUT_MAX_MS} 的整数毫秒`,
      value,
    );
  }
  return value;
}

function requireProjectScopedDefinitions(context: ValidationContext): void {
  if (context.entity?.type === 'global_settings') {
    throw fieldError(context, 'payload.policies.verification', 'Task 检查定义必须保存于项目 scope，不能跨项目共享');
  }
}

function validateCheckDefinitions(value: unknown, context: ValidationContext, field: string): CheckDefinition[] {
  requireProjectScopedDefinitions(context);
  if (!Array.isArray(value) || value.length < 1 || value.length > TASK_CHECK_DEFINITIONS_MAX_COUNT) {
    throw fieldError(context, field, `必须是 1..${TASK_CHECK_DEFINITIONS_MAX_COUNT} 项定义数组`, value);
  }
  const result: CheckDefinition[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const itemField = `${field}[${index}]`;
    const object = requirePlainObject(raw, context, itemField);
    rejectUnknownKeys(object, CHECK_KEYS, context, itemField);
    for (const key of CHECK_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) {
        throw fieldError(context, `${itemField}.${key}`, '缺少必填字段');
      }
    }
    const checkKey = validateCheckKey(object.checkKey, context, `${itemField}.checkKey`);
    if (seen.has(checkKey)) {
      throw fieldError(context, `${itemField}.checkKey`, '检查身份重复（项目内必须唯一）', object.checkKey);
    }
    seen.add(checkKey);
    if (typeof object.scope !== 'string' || !CHECK_SCOPES.has(object.scope as TaskCheckScope)) {
      throw fieldError(context, `${itemField}.scope`, "必须是 'task'、'module' 或 'project'", object.scope);
    }
    if (object.kind !== 'command') {
      throw new StorageError('validation', context.operation, `${context.operation}: ${itemField}.kind 当前仅支持 command`, {
        entity: context.entity,
        details: { field: `${itemField}.kind`, reason: 'unsupported_execution_kind' },
      });
    }
    const requirementRefs = validateStringList(object.requirementRefs, context, `${itemField}.requirementRefs`, {
      min: 0,
      max: TASK_CHECK_REQUIREMENT_REFS_MAX_COUNT,
      path: false,
    });
    if (typeof object.required !== 'boolean') {
      throw fieldError(context, `${itemField}.required`, '必须是布尔值', object.required);
    }
    result.push({
      checkKey,
      scope: object.scope as TaskCheckScope,
      kind: 'command',
      argv: validateArgv(object.argv, context, `${itemField}.argv`),
      cwdRef: validateNullableRef(object.cwdRef, context, `${itemField}.cwdRef`),
      environmentRef: validateNullableRef(object.environmentRef, context, `${itemField}.environmentRef`),
      timeout: validateTimeout(object.timeout, context, `${itemField}.timeout`),
      required: object.required as boolean,
      requirementRefs,
    });
  }
  return result;
}

function validateModules(value: unknown, context: ValidationContext, field: string): VerificationModuleDefinition[] {
  requireProjectScopedDefinitions(context);
  if (!Array.isArray(value) || value.length < 1 || value.length > TASK_CHECK_MODULES_MAX_COUNT) {
    throw fieldError(context, field, `必须是 1..${TASK_CHECK_MODULES_MAX_COUNT} 项模块数组`, value);
  }
  const result: VerificationModuleDefinition[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const itemField = `${field}[${index}]`;
    const object = requirePlainObject(raw, context, itemField);
    rejectUnknownKeys(object, MODULE_KEYS, context, itemField);
    for (const key of MODULE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) {
        throw fieldError(context, `${itemField}.${key}`, '缺少必填字段');
      }
    }
    const moduleKey = validateReference(object.moduleKey, context, `${itemField}.moduleKey`);
    if (seen.has(moduleKey)) {
      throw fieldError(context, `${itemField}.moduleKey`, '模块身份重复（项目内必须唯一）', object.moduleKey);
    }
    seen.add(moduleKey);
    result.push({
      moduleKey,
      allowedTargets: validateStringList(object.allowedTargets, context, `${itemField}.allowedTargets`, {
        min: 1,
        max: TASK_CHECK_TARGETS_MAX_COUNT,
        path: true,
      }),
      impactScope: validateStringList(object.impactScope, context, `${itemField}.impactScope`, {
        min: 1,
        max: TASK_CHECK_TARGETS_MAX_COUNT,
        path: true,
      }),
      sharedHighRiskFiles: validateStringList(object.sharedHighRiskFiles, context, `${itemField}.sharedHighRiskFiles`, {
        min: 0,
        max: TASK_CHECK_TARGETS_MAX_COUNT,
        path: true,
      }),
    });
  }
  return result;
}

function validateReferenceList(value: unknown, context: ValidationContext, field: string, max: number): string[] {
  return validateStringList(value, context, field, { min: 1, max, path: false });
}

function validateFullFallback(
  value: unknown,
  context: ValidationContext,
  field: string,
  checks: readonly CheckDefinition[] | undefined,
  modules: readonly VerificationModuleDefinition[] | undefined,
): VerificationFullFallback {
  requireProjectScopedDefinitions(context);
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, FALLBACK_KEYS, context, field);
  const checkRefs = validateReferenceList(object.checkRefs, context, `${field}.checkRefs`, TASK_CHECK_DEFINITIONS_MAX_COUNT);
  const checkIds = new Set((checks ?? []).map((entry) => entry.checkKey));
  for (const [index, ref] of checkRefs.entries()) {
    if (!checkIds.has(ref)) {
      throw fieldError(context, `${field}.checkRefs[${index}]`, '引用了未定义的检查身份（无效检查引用）', ref);
    }
  }
  let moduleRefs: string[] | undefined;
  if (object.moduleRefs !== undefined) {
    moduleRefs = validateReferenceList(object.moduleRefs, context, `${field}.moduleRefs`, TASK_CHECK_MODULES_MAX_COUNT);
    const moduleIds = new Set((modules ?? []).map((entry) => entry.moduleKey));
    for (const [index, ref] of moduleRefs.entries()) {
      if (!moduleIds.has(ref)) {
        throw fieldError(context, `${field}.moduleRefs[${index}]`, '引用了未定义的模块身份（无效模块引用）', ref);
      }
    }
  }
  return moduleRefs === undefined ? { checkRefs } : { checkRefs, moduleRefs };
}

/** 校验并复制 F-001 用户确认的 verification 政策段。 */
export function validateConfirmedTaskVerificationPolicy(
  value: unknown,
  context: ValidationContext,
  field = 'payload.policies.verification',
): ConfirmedTaskVerificationPolicy {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, POLICY_KEYS, context, field);
  const result: {
    requireChecksBeforeDone?: boolean;
    checkDefinitions?: readonly CheckDefinition[];
    modules?: readonly VerificationModuleDefinition[];
    fullFallback?: VerificationFullFallback;
  } = {};
  if (object.requireChecksBeforeDone !== undefined) {
    if (typeof object.requireChecksBeforeDone !== 'boolean') {
      throw fieldError(context, `${field}.requireChecksBeforeDone`, '必须是布尔值', object.requireChecksBeforeDone);
    }
    result.requireChecksBeforeDone = object.requireChecksBeforeDone;
  }
  const checks = object.checkDefinitions === undefined
    ? undefined
    : validateCheckDefinitions(object.checkDefinitions, context, `${field}.checkDefinitions`);
  const modules = object.modules === undefined
    ? undefined
    : validateModules(object.modules, context, `${field}.modules`);
  if (checks !== undefined) result.checkDefinitions = checks;
  if (modules !== undefined) result.modules = modules;
  if (object.fullFallback !== undefined) {
    result.fullFallback = validateFullFallback(
      object.fullFallback,
      context,
      `${field}.fullFallback`,
      checks,
      modules,
    );
  }
  if (object.fullFallback !== undefined && checks === undefined) {
    throw fieldError(context, `${field}.checkDefinitions`, '提供 fullFallback 时必须同时提供 checkDefinitions');
  }
  if (checks !== undefined && object.fullFallback === undefined) {
    throw fieldError(context, `${field}.fullFallback`, '提供显式检查定义时必须配置安全全量回退引用');
  }
  return result;
}

/** 仅供配置 schema 使用的最小类型守卫，避免未使用导入被误认为可执行校验。 */
export function isConfirmedTaskVerificationPolicy(value: unknown): value is ConfirmedTaskVerificationPolicy {
  return isPlainObject(value) && ('checkDefinitions' in value || 'modules' in value || 'fullFallback' in value);
}
