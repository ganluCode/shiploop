/**
 * P05-2 Feature 层 DAG 端口与纯规则。
 *
 * Feature 依赖是 Project → Phase → Feature → Task 中的外层图，和
 * task_dependencies 使用不同的节点集合与结果语义。这里不读库、不写库，也不把
 * Feature 通过或代码集成事实写回；SQLite 原子更新与查询适配由后续 Feature 接入。
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

export const FEATURE_DAG_REASONS = [
  'ready',
  'dependency_pending',
  'dependency_failed',
  'integration_not_ready',
  'invalid_graph',
] as const;
export type FeatureDagReason = (typeof FEATURE_DAG_REASONS)[number];

export const FEATURE_DEPENDENCY_COMPLETION = ['complete', 'pending', 'failed'] as const;
export type FeatureDependencyCompletion = (typeof FEATURE_DEPENDENCY_COMPLETION)[number];

export interface FeatureIntegrationEvidence {
  /** 固定集成操作或证据身份；没有该对象不能声称代码已集成。 */
  readonly integrationId?: string;
  /** 已核对的成果 commit；纯规则层只保存身份，不执行 Git。 */
  readonly commitSha?: string;
  /** 可选的目标基线身份。 */
  readonly targetBaseline?: string;
}

export interface FeatureDagNodeInput {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId: string;
  /** 仅用于依赖完成投影；Task 状态不在此结构中解释。 */
  readonly status?: string;
  /** 成功交付不自动生成此证据，缺失时 integrationReady 必须为 false。 */
  readonly integrationEvidence?: FeatureIntegrationEvidence | null;
}

export interface FeatureDependencyInput {
  readonly id?: string;
  readonly projectId?: string;
  readonly phaseId?: string;
  readonly featureId: string;
  readonly dependsOnId: string;
  /** 依赖边关联的固定基线引用，不等同于集成已通过。 */
  readonly codeBaselineRef?: string | null;
}

export interface FeatureDagInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly features: readonly FeatureDagNodeInput[];
  /** 已持久化边；与 candidateEdges 合并后统一做重复和环校验。 */
  readonly existingEdges?: readonly FeatureDependencyInput[];
  /** 本次拟添加的边。 */
  readonly candidateEdges?: readonly FeatureDependencyInput[];
}

export interface FeatureDependencyRecord {
  readonly id: string | null;
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly dependsOnId: string;
  readonly codeBaselineRef: string | null;
}

export interface FeatureDagGraph {
  readonly projectId: string;
  readonly phaseId: string;
  readonly features: readonly FeatureDagNodeInput[];
  readonly edges: readonly FeatureDependencyRecord[];
  readonly topologicalOrder: readonly string[];
}

export interface FeatureDagReadiness {
  readonly featureId: string;
  /** 仅表示前置 Feature 的业务完成状态，不读取或推断其 Task DAG。 */
  readonly dependencyCompleted: boolean;
  readonly dependencyCompletion: FeatureDependencyCompletion;
  /** 当前 Feature 自身是否有明确的固定集成证据。 */
  readonly integrationReady: boolean;
  /** 所有前置 Feature 是否均有固定集成证据。 */
  readonly dependencyIntegrationReady: boolean;
  /** 可作为执行候选的外层结果，依赖完成和前置集成均满足。 */
  readonly ready: boolean;
  readonly reason: FeatureDagReason;
}

export interface FeatureDagEvaluation extends FeatureDagGraph {
  readonly edges: readonly FeatureDependencyRecord[];
  readonly readiness: readonly FeatureDagReadiness[];
  readonly readyFeatureIds: readonly string[];
}

/** 结构化 Feature DAG 业务错误；details 只包含稳定原因和节点身份。 */
export class FeatureDagError extends StorageError {
  constructor(reason: string, details: Readonly<Record<string, unknown>> = {}) {
    super('validation', 'FeatureDag.validate', 'Feature DAG 校验失败', {
      details: { reason, ...details },
    });
    this.name = 'FeatureDagError';
  }
}

const OPERATION = 'FeatureDag.validate';
const MAX_FEATURES = 1_000;
const MAX_EDGES = 5_000;

function fail(reason: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new FeatureDagError(reason, details);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedIds(values: Iterable<string>): string[] {
  return [...values].sort(compareIds);
}

function validateOptionalText(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw validationError(context, field, '必须是长度不超过 512 的非空字符串或 null', value);
  }
  return value;
}

function validateEvidence(value: unknown, context: ValidationContext, field: string): FeatureIntegrationEvidence | null {
  if (value === undefined || value === null) return null;
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['integrationId', 'commitSha', 'targetBaseline'], context, field);
  const integrationId = validateOptionalText(object.integrationId, context, `${field}.integrationId`);
  const commitSha = validateOptionalText(object.commitSha, context, `${field}.commitSha`);
  const targetBaseline = validateOptionalText(object.targetBaseline, context, `${field}.targetBaseline`);
  if (integrationId === null && commitSha === null && targetBaseline === null) {
    throw validationError(context, field, '集成证据至少需要一个固定身份字段');
  }
  return { ...(integrationId === null ? {} : { integrationId }),
    ...(commitSha === null ? {} : { commitSha }),
    ...(targetBaseline === null ? {} : { targetBaseline }) };
}

function validateNode(raw: unknown, index: number, root: { projectId: string; phaseId: string }): FeatureDagNodeInput {
  const context: ValidationContext = { operation: OPERATION };
  const field = `features[${index}]`;
  const object = requirePlainObject(raw, context, field);
  rejectUnknownKeys(object, [
    'id', 'projectId', 'phaseId', 'title', 'description', 'labels', 'status', 'deliveryStatus',
    'planStatus', 'planDigest', 'sourceRefs', 'revision', 'createdAtUtcMs', 'updatedAtUtcMs',
    'integrationEvidence',
  ], context, field);
  const id = validateStableId(object.id, context, `${field}.id`);
  const projectId = validateStableId(object.projectId, context, `${field}.projectId`);
  const phaseId = validateStableId(object.phaseId, context, `${field}.phaseId`);
  if (projectId !== root.projectId) fail('cross_project', { featureId: id });
  if (phaseId !== root.phaseId) fail('cross_phase', { featureId: id });
  const status = object.status === undefined ? 'draft' : typeof object.status === 'string'
    ? object.status : (() => { throw validationError(context, `${field}.status`, '必须是字符串', object.status); })();
  const integrationEvidence = validateEvidence(object.integrationEvidence, context, `${field}.integrationEvidence`);
  return { id, projectId, phaseId, status, integrationEvidence };
}

function validateEdge(
  raw: unknown,
  index: number,
  root: { projectId: string; phaseId: string },
): FeatureDependencyRecord {
  const context: ValidationContext = { operation: OPERATION };
  const field = `edges[${index}]`;
  const object = requirePlainObject(raw, context, field);
  rejectUnknownKeys(object, [
    'id', 'projectId', 'phaseId', 'featureId', 'dependsOnId', 'codeBaselineRef',
    'revision', 'createdAtUtcMs', 'updatedAtUtcMs',
  ], context, field);
  const featureId = validateStableId(object.featureId, context, `${field}.featureId`);
  const dependsOnId = validateStableId(object.dependsOnId, context, `${field}.dependsOnId`);
  const projectId = object.projectId === undefined ? root.projectId
    : validateStableId(object.projectId, context, `${field}.projectId`);
  const phaseId = object.phaseId === undefined ? root.phaseId
    : validateStableId(object.phaseId, context, `${field}.phaseId`);
  const id = object.id === undefined || object.id === null ? null
    : validateStableId(object.id, context, `${field}.id`);
  const codeBaselineRef = validateOptionalText(object.codeBaselineRef, context, `${field}.codeBaselineRef`);
  if (projectId !== root.projectId) fail('cross_project', { featureId, dependsOnFeatureId: dependsOnId });
  if (phaseId !== root.phaseId) fail('cross_phase', { featureId, dependsOnFeatureId: dependsOnId });
  return { id, projectId, phaseId, featureId, dependsOnId, codeBaselineRef };
}

function topologicalOrder(
  featureIds: readonly string[],
  edges: readonly FeatureDependencyRecord[],
): string[] {
  const dependencies = new Map(featureIds.map((id) => [id, new Set<string>()] as const));
  for (const edge of edges) dependencies.get(edge.featureId)!.add(edge.dependsOnId);
  const remaining = new Set(featureIds);
  const order: string[] = [];
  while (remaining.size > 0) {
    const next = sortedIds(remaining).find((id) => [...dependencies.get(id)!].every((dependency) => !remaining.has(dependency)));
    if (next === undefined) {
      const cycle = detectFeatureDependencyCycle(featureIds, edges);
      fail('cycle', { cycle });
    }
    order.push(next);
    remaining.delete(next);
  }
  return order;
}

/** 三色 DFS，按节点和邻接边稳定排序返回环路径。 */
export function detectFeatureDependencyCycle(
  featureIds: readonly string[],
  edges: readonly Pick<FeatureDependencyRecord, 'featureId' | 'dependsOnId'>[],
): string[] | undefined {
  const adjacency = new Map(featureIds.map((id) => [id, [] as string[]] as const));
  for (const edge of edges) adjacency.get(edge.featureId)?.push(edge.dependsOnId);
  for (const targets of adjacency.values()) targets.sort();
  const color = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    color.set(id, 1); path.push(id);
    for (const dependency of adjacency.get(id) ?? []) {
      if (color.get(dependency) === 1) {
        const start = path.indexOf(dependency);
        return [...path.slice(start), dependency];
      }
      if (!color.get(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    path.pop(); color.set(id, 2);
    return undefined;
  };
  for (const id of sortedIds(featureIds)) if (!color.get(id)) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

/** 校验已有边与候选边的合并图，并输出规范化、稳定排序的图。 */
export function validateFeatureDag(value: unknown): FeatureDagGraph {
  const context: ValidationContext = { operation: OPERATION };
  const input = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(input, ['projectId', 'phaseId', 'features', 'existingEdges', 'candidateEdges'], context, 'input');
  const projectId = validateStableId(input.projectId, context, 'input.projectId');
  const phaseId = validateStableId(input.phaseId, context, 'input.phaseId');
  if (!Array.isArray(input.features) || input.features.length > MAX_FEATURES) {
    throw validationError(context, 'input.features', `必须是最多 ${MAX_FEATURES} 项的数组`, input.features);
  }
  const features = input.features.map((raw, index) => validateNode(raw, index, { projectId, phaseId }));
  const featureIds = features.map((feature) => feature.id);
  const uniqueFeatureIds = new Set(featureIds);
  if (uniqueFeatureIds.size !== featureIds.length) fail('duplicate_feature');
  const existing = input.existingEdges === undefined ? [] : input.existingEdges;
  const candidates = input.candidateEdges === undefined ? [] : input.candidateEdges;
  if (!Array.isArray(existing) || !Array.isArray(candidates) || existing.length + candidates.length > MAX_EDGES) {
    throw validationError(context, 'input.edges', `必须是最多 ${MAX_EDGES} 条边的数组`);
  }
  const edges = [...existing, ...candidates].map((raw, index) => validateEdge(raw, index, { projectId, phaseId }));
  const featureSet = new Set(featureIds);
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.featureId}\u0000${edge.dependsOnId}`;
    if (!featureSet.has(edge.featureId) || !featureSet.has(edge.dependsOnId)) {
      fail('missing_feature', { featureId: edge.featureId, dependsOnFeatureId: edge.dependsOnId });
    }
    if (edge.featureId === edge.dependsOnId) {
      fail('self_dependency', { featureId: edge.featureId });
    }
    if (edgeKeys.has(key)) {
      fail('duplicate_edge', { featureId: edge.featureId, dependsOnFeatureId: edge.dependsOnId });
    }
    edgeKeys.add(key);
  }
  const sortedFeatures = [...features].sort((left, right) => compareIds(left.id, right.id));
  const sortedEdges = [...edges].sort((left, right) => compareIds(left.featureId, right.featureId)
    || compareIds(left.dependsOnId, right.dependsOnId));
  return {
    projectId, phaseId, features: sortedFeatures, edges: sortedEdges,
    topologicalOrder: topologicalOrder(sortedFeatures.map((feature) => feature.id), sortedEdges),
  };
}

export function deriveFeatureDagReadiness(graph: FeatureDagGraph): readonly FeatureDagReadiness[] {
  const byId = new Map(graph.features.map((feature) => [feature.id, feature] as const));
  const dependencies = new Map(graph.features.map((feature) => [feature.id, [] as FeatureDagNodeInput[]] as const));
  for (const edge of graph.edges) dependencies.get(edge.featureId)!.push(byId.get(edge.dependsOnId)!);
  return graph.features.map((feature) => {
    const parents = dependencies.get(feature.id)!;
    const failed = parents.some((parent) => ['failed', 'cancelled', 'skipped'].includes(parent.status ?? 'draft'));
    const dependencyCompleted = parents.every((parent) => parent.status === 'completed');
    const dependencyIntegrationReady = parents.every((parent) => parent.integrationEvidence !== null
      && parent.integrationEvidence !== undefined);
    const integrationReady = feature.integrationEvidence !== null && feature.integrationEvidence !== undefined;
    const reason: FeatureDagReason = failed ? 'dependency_failed'
      : !dependencyCompleted ? 'dependency_pending'
        : !dependencyIntegrationReady ? 'integration_not_ready' : 'ready';
    return {
      featureId: feature.id,
      dependencyCompleted,
      dependencyCompletion: failed ? 'failed' : dependencyCompleted ? 'complete' : 'pending',
      integrationReady,
      dependencyIntegrationReady,
      ready: reason === 'ready',
      reason,
    };
  });
}

export function evaluateFeatureDag(value: unknown): FeatureDagEvaluation {
  const graph = validateFeatureDag(value);
  const readiness = deriveFeatureDagReadiness(graph);
  return { ...graph, readiness, readyFeatureIds: readiness.filter((item) => item.ready).map((item) => item.featureId) };
}

/** 兼容端口命名：输入校验和外层图校验是同一套规则，避免形成第二份 DAG 实现。 */
export const validateFeatureDagInput = validateFeatureDag;
export const validateFeatureDependencyGraph = validateFeatureDag;
export const evaluateFeatureDependencyGraph = evaluateFeatureDag;

/** 与 TaskDagStore 对称的只读 Core 端口；实现可在后续 SQLite/query Feature 中注入。 */
export interface FeatureDagStore {
  readFeatureDag(projectId: unknown, phaseId: unknown): FeatureDagInput;
}

export function createFeatureDagService(options: { readonly store: FeatureDagStore }) {
  return {
    evaluate(projectId: unknown, phaseId: unknown): FeatureDagEvaluation {
      const context: ValidationContext = { operation: 'FeatureDag.read' };
      const validProjectId = validateStableId(projectId, context, 'projectId');
      const validPhaseId = validateStableId(phaseId, context, 'phaseId');
      const input = options.store.readFeatureDag(validProjectId, validPhaseId);
      if (!isPlainObject(input) || input.projectId !== validProjectId || input.phaseId !== validPhaseId) {
        throw new StorageError('corrupt', 'FeatureDag.read', 'Invalid persisted Feature DAG view', {
          details: { reason: 'invalid_graph' },
        });
      }
      return evaluateFeatureDag(input);
    },
  };
}
