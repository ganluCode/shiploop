/**
 * P05-1 / F-001 一次性规划请求与规划候选纯校验行为回归（纯函数，无 I/O）。
 *
 * 覆盖（F-001 验收标准 1/2/3）：
 * - 版本化规划请求：绑定 Project/Phase/Feature、需求制品、约束、验收与用户
 *   批准的规划策略；缺省形态归一（constraints/taskLimit/requirementRefs）；
 *   未知版本、未知字段、非法结构返回可定位且脱敏的错误；
 * - 版本化规划候选：独立封装承载既有业务计划 v1（复用 validateFeaturePlanInput，
 *   不另建 Task DAG 校验器）与定向 verification 意图；候选身份封装生成前允许
 *   无 Artifact 引用；Run.purpose=plan、Task.kind=planning、Runtime
 *   identity.purpose=work 常量冻结；
 * - verification 只引用受信检查/模块与影响范围：payload 与 taskVerification 条目
 *   的键白名单外字段（argv/shell/environment/vendor/model/credentials/passed
 *   等执行语义）一律按未知字段拒绝；
 * - 复用业务计划 v1 的 DAG 负例：重复 ID、缺依赖、自依赖、环均来自
 *   validateFeaturePlanInput 的既有定位错误，本模块不重复实现；
 * - 错误脱敏：details 只含 field/reason/定位键/receivedType，不回显输入正文。
 *
 * 本套件不触库、不创建 Run/Attempt/Artifact、不调用模型。
 */
import { describe, expect, it } from 'vitest';
import { StorageError } from '../../../packages/core/src/ports/errors.ts';
import {
  PLANNING_CANDIDATE_FORBIDDEN_EXECUTION_FIELDS,
  PLANNING_CANDIDATE_SCHEMA_VERSION,
  PLANNING_REQUEST_CONSTRAINTS_MAX_COUNT,
  PLANNING_REQUEST_SCHEMA_VERSION,
  PLANNING_RUNTIME_IDENTITY_PURPOSE,
  PLANNING_RUN_PURPOSE,
  PLANNING_TASK_KIND,
  PLANNING_TASK_CHECK_REFS_MAX_COUNT,
  PLANNING_TASK_IMPACT_SCOPE_MAX_COUNT,
  PLANNING_TASK_MODULE_REFS_MAX_COUNT,
  validatePlanningCandidateIdentity,
  validatePlanningCandidatePayload,
  validatePlanningRequest,
} from '../../../packages/core/src/ports/planning-candidates.ts';
import { PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH } from '../../../packages/core/src/ports/feature-plan.ts';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';

void PLANNING_CANDIDATE_SCHEMA_VERSION;
void PLANNING_REQUEST_CONSTRAINTS_MAX_COUNT;
void PLANNING_TASK_CHECK_REFS_MAX_COUNT;
void PLANNING_TASK_IMPACT_SCOPE_MAX_COUNT;
void PLANNING_TASK_MODULE_REFS_MAX_COUNT;

/** 捕获校验错误并断言其脱敏形态（kind/field 定位；不回显正文）。 */
function captureValidationError(fn: () => unknown): StorageError {
  try {
    fn();
  } catch (error) {
    if (isStorageError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('预期抛出 StorageError(kind=validation)，但校验通过');
}

function expectFieldError(fn: () => unknown, field: string): StorageError {
  const error = captureValidationError(fn);
  expect(error.kind).toBe('validation');
  expect(error.details?.field).toBe(field);
  return error;
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function validRequestInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: 'proj-1',
    phaseId: 'phase-1',
    featureId: 'feature-p05',
    requirementRefs: [
      { artifactId: 'art-req-2' },
      { artifactId: 'art-req-1', contentHash: 'a'.repeat(64) },
    ],
    constraints: ['macOS 首版', '复用 P03/P04 实现'],
    acceptance: {
      criteria: ['重复命令只有一个规划 Run 和一次候选发布', '未批准不能编码'],
    },
    strategy: { approvalMode: 'manual', taskLimit: 12 },
  };
}

function validPlanInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '一次性规划候选',
      description: 'P05-1 规划产出的业务计划。',
      labels: ['p05'],
      sourceRefs: [{ artifactId: 'art-req-1' }],
    },
    tasks: [
      {
        id: 't-1',
        title: '契约校验',
        complexity: 'medium',
        acceptance: { criteria: ['负例可定位'] },
      },
      {
        id: 't-2',
        title: '摘要计算',
        complexity: 'low',
        acceptance: { criteria: ['摘要稳定'] },
        dependsOn: ['t-1'],
      },
    ],
  };
}

function validCandidateInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: 'proj-1',
    featureId: 'feature-p05',
    runId: 'run-plan-1',
    candidateId: 'cand-0001',
    plan: validPlanInput(),
    taskVerification: [
      {
        taskId: 't-1',
        checkRefs: ['unit-core'],
        moduleRefs: ['core'],
        impactScope: ['packages/core/src/ports'],
      },
      {
        taskId: 't-2',
        checkRefs: ['typecheck', 'unit-core'],
        moduleRefs: [],
        impactScope: ['packages/core/src/ports/planning-candidates.ts'],
      },
    ],
    summary: '两任务链：契约校验与摘要计算；全部引用受信检查。',
  };
}

/* ------------------------------------------------------------------ *
 * 规划请求校验
 * ------------------------------------------------------------------ */

describe('P05-1 / F-001 一次性规划请求校验', () => {
  it('正常请求通过：绑定三实体、需求制品、约束、验收与用户批准策略，输出 inputDigest', () => {
    const request = validatePlanningRequest(validRequestInput());
    expect(request.schemaVersion).toBe(PLANNING_REQUEST_SCHEMA_VERSION);
    expect(request.projectId).toBe('proj-1');
    expect(request.phaseId).toBe('phase-1');
    expect(request.featureId).toBe('feature-p05');
    // 引用排序归一（与业务计划引用同一规则：按 artifactId 排序）。
    expect(request.requirementRefs).toEqual([
      { artifactId: 'art-req-1', contentHash: 'a'.repeat(64) },
      { artifactId: 'art-req-2' },
    ]);
    expect(request.constraints).toEqual(['macOS 首版', '复用 P03/P04 实现']);
    expect(request.acceptance.criteria).toEqual([
      '重复命令只有一个规划 Run 和一次候选发布',
      '未批准不能编码',
    ]);
    expect(request.strategy).toEqual({ approvalMode: 'manual', taskLimit: 12 });
    expect(request.inputDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('缺省形态归一：constraints/requirementRefs 省略为空数组，taskLimit 省略为 null；重复约束去重', () => {
    const request = validatePlanningRequest({
      schemaVersion: 1,
      projectId: 'proj-1',
      phaseId: 'phase-1',
      featureId: 'feature-p05',
      constraints: ['  复用 P03/P04 实现  ', '复用 P03/P04 实现'],
      acceptance: { criteria: ['验收一'] },
      strategy: { approvalMode: 'manual' },
    });
    expect(request.requirementRefs).toEqual([]);
    expect(request.constraints).toEqual(['复用 P03/P04 实现']);
    expect(request.strategy).toEqual({ approvalMode: 'manual', taskLimit: null });

    // taskLimit null 与省略等价（与 complexity 的归一约定一致）。
    const nullLimit = validatePlanningRequest({
      ...validRequestInput(),
      strategy: { approvalMode: 'manual', taskLimit: null },
    });
    expect(nullLimit.strategy).toEqual({ approvalMode: 'manual', taskLimit: null });
  });

  it('未知版本拒绝：schemaVersion 0/2/字符串/缺失均定位到 schemaVersion 字段', () => {
    for (const schemaVersion of [0, 2, '1', null, undefined]) {
      const input = validRequestInput();
      if (schemaVersion === undefined) {
        delete input.schemaVersion;
      } else {
        input.schemaVersion = schemaVersion;
      }
      expectFieldError(() => validatePlanningRequest(input), 'schemaVersion');
    }
  });

  it('未知字段拒绝（含 CAS 纪律与执行语义字段），错误消息携带字段名', () => {
    for (const [key, value] of [
      ['expectedRevision', 3],
      ['model', 'gpt-4o'],
      ['argv', ['npm', 'test']],
      ['approval', { approved: true }],
    ] as const) {
      const input = validRequestInput();
      input[key] = value;
      const error = expectFieldError(() => validatePlanningRequest(input), 'input');
      expect(error.message).toContain(key);
    }
  });

  it('非法结构拒绝：非对象、缺实体绑定、非法稳定 ID、引用形态非法', () => {
    expectFieldError(() => validatePlanningRequest('not-an-object'), 'input');
    expectFieldError(() => validatePlanningRequest(null), 'input');
    for (const key of ['projectId', 'phaseId', 'featureId'] as const) {
      const input = validRequestInput();
      delete input[key];
      expectFieldError(() => validatePlanningRequest(input), key);
    }
    const badId = validRequestInput();
    badId.featureId = 'bad id!';
    expectFieldError(() => validatePlanningRequest(badId), 'featureId');

    const badRefs = validRequestInput();
    badRefs.requirementRefs = [{ artifactId: 'art-req-1', contentHash: 'XYZ' }];
    expectFieldError(() => validatePlanningRequest(badRefs), 'requirementRefs[0].contentHash');

    const notArray = validRequestInput();
    notArray.requirementRefs = 'art-req-1';
    expectFieldError(() => validatePlanningRequest(notArray), 'requirementRefs');
  });

  it('约束负例：空/全空白/超长/超量/非字符串数组均拒绝', () => {
    for (const [value, field] of [
      [['ok', ''], 'constraints[1]'],
      [['ok', '   '], 'constraints[1]'],
      [[123], 'constraints[0]'],
      ['not-array', 'constraints'],
    ] as const) {
      const input = validRequestInput();
      input.constraints = value;
      expectFieldError(() => validatePlanningRequest(input), field as string);
    }
    const tooLong = validRequestInput();
    tooLong.constraints = ['x'.repeat(PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH + 1)];
    expectFieldError(() => validatePlanningRequest(tooLong), 'constraints[0]');

    const tooMany = validRequestInput();
    tooMany.constraints = Array.from(
      { length: PLANNING_REQUEST_CONSTRAINTS_MAX_COUNT + 1 },
      (_, index) => `约束 ${index}`,
    );
    expectFieldError(() => validatePlanningRequest(tooMany), 'constraints');
  });

  it('验收负例：缺失/空条目复用业务计划结构化验收规则', () => {
    const missing = validRequestInput();
    delete missing.acceptance;
    expectFieldError(() => validatePlanningRequest(missing), 'acceptance');

    const empty = validRequestInput();
    empty.acceptance = { criteria: [] };
    expectFieldError(() => validatePlanningRequest(empty), 'acceptance.criteria');

    const unknown = validRequestInput();
    unknown.acceptance = { criteria: ['一条'], note: 'extra' };
    expectFieldError(() => validatePlanningRequest(unknown), 'acceptance');
  });

  it('策略负例：未知 approvalMode、缺失、非法 taskLimit、未知键', () => {
    const auto = validRequestInput();
    auto.strategy = { approvalMode: 'auto', taskLimit: 3 };
    expectFieldError(() => validatePlanningRequest(auto), 'strategy.approvalMode');

    const missing = validRequestInput();
    missing.strategy = { taskLimit: 3 };
    expectFieldError(() => validatePlanningRequest(missing), 'strategy.approvalMode');

    for (const taskLimit of [0, 101, 1.5, '12']) {
      const input = validRequestInput();
      input.strategy = { approvalMode: 'manual', taskLimit };
      expectFieldError(() => validatePlanningRequest(input), 'strategy.taskLimit');
    }

    const unknownKey = validRequestInput();
    unknownKey.strategy = { approvalMode: 'manual', taskLimit: 3, model: 'gpt-4o' };
    const error = expectFieldError(() => validatePlanningRequest(unknownKey), 'strategy');
    expect(error.message).toContain('model');
  });
});

/* ------------------------------------------------------------------ *
 * 规划候选校验
 * ------------------------------------------------------------------ */

describe('P05-1 / F-001 规划候选 payload 校验', () => {
  it('正常候选通过：承载规范化业务计划 v1、排序后的 verification 意图与审批摘要', () => {
    const candidate = validatePlanningCandidatePayload(validCandidateInput());
    expect(candidate.schemaVersion).toBe(PLANNING_CANDIDATE_SCHEMA_VERSION);
    expect(candidate.projectId).toBe('proj-1');
    expect(candidate.featureId).toBe('feature-p05');
    expect(candidate.runId).toBe('run-plan-1');
    expect(candidate.candidateId).toBe('cand-0001');
    // 业务计划 v1 原样复用：planDigest 与任务排序来自 validateFeaturePlanInput。
    expect(candidate.plan.taskCount).toBe(2);
    expect(candidate.plan.tasks.map((task) => task.id)).toEqual(['t-1', 't-2']);
    expect(candidate.plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    // taskVerification 按 taskId 排序；内部引用列表排序。
    expect(candidate.taskVerification.map((intent) => intent.taskId)).toEqual(['t-1', 't-2']);
    expect(candidate.taskVerification[1]!.checkRefs).toEqual(['typecheck', 'unit-core']);
    expect(candidate.summary).toBe('两任务链：契约校验与摘要计算；全部引用受信检查。');
    expect(candidate.candidateDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Run/Task/Runtime 身份常量冻结：purpose=plan、kind=planning、identity.purpose=work', () => {
    expect(PLANNING_RUN_PURPOSE).toBe('plan');
    expect(PLANNING_TASK_KIND).toBe('planning');
    expect(PLANNING_RUNTIME_IDENTITY_PURPOSE).toBe('work');
  });

  it('taskVerification 与其内部清单允许省略：分别归一为空', () => {
    const input = validCandidateInput();
    delete input.taskVerification;
    const candidate = validatePlanningCandidatePayload(input);
    expect(candidate.taskVerification).toEqual([]);

    const partial = validCandidateInput();
    partial.taskVerification = [{ taskId: 't-1' }];
    const normalized = validatePlanningCandidatePayload(partial);
    expect(normalized.taskVerification).toEqual([
      { taskId: 't-1', checkRefs: [], moduleRefs: [], impactScope: [] },
    ]);
  });

  it('受信检查/模块解析上下文：未知引用按字段定位拒绝，已知引用通过', () => {
    const options = {
      knownChecks: new Set(['unit-core', 'typecheck']),
      knownModules: new Set(['core']),
    };
    const candidate = validatePlanningCandidatePayload(validCandidateInput(), options);
    expect(candidate.taskVerification[0]!.checkRefs).toEqual(['unit-core']);

    const input = validCandidateInput();
    (input.taskVerification as Record<string, unknown>[])[0]!.checkRefs = ['unknown-check'];
    // 脱敏：错误不回显引用值，但字段定位精确到 taskVerification[0].checkRefs[0]。
    const error = expectFieldError(
      () => validatePlanningCandidatePayload(input, options),
      'taskVerification[0].checkRefs[0]',
    );
    expect(error.message).toContain('受信清单内不存在');
    expect(JSON.stringify(error.details)).not.toContain('unknown-check');

    const moduleInput = validCandidateInput();
    (moduleInput.taskVerification as Record<string, unknown>[])[0]!.moduleRefs = ['ghost-module'];
    expectFieldError(
      () => validatePlanningCandidatePayload(moduleInput, options),
      'taskVerification[0].moduleRefs[0]',
    );
  });

  it('未知版本与未知字段拒绝：执行语义字段在 payload 层全部按未知字段拒绝', () => {
    for (const schemaVersion of [0, 2, '1']) {
      const input = validCandidateInput();
      input.schemaVersion = schemaVersion;
      expectFieldError(() => validatePlanningCandidatePayload(input), 'schemaVersion');
    }

    for (const field of PLANNING_CANDIDATE_FORBIDDEN_EXECUTION_FIELDS) {
      const input = validCandidateInput();
      input[field] = field === 'argv' || field === 'environment' ? ['npm', 'test'] : 'x';
      const error = expectFieldError(() => validatePlanningCandidatePayload(input), 'input');
      expect(error.message).toContain(field);
    }
  });

  it('verification 意图条目内的执行语义字段（argv/shell/环境/厂商/模型/凭据/通过标志）全部拒绝', () => {
    for (const field of PLANNING_CANDIDATE_FORBIDDEN_EXECUTION_FIELDS) {
      const input = validCandidateInput();
      (input.taskVerification as Record<string, unknown>[])[0]![field] =
        field === 'argv' ? ['npm', 'test'] : 'x';
      const error = expectFieldError(
        () => validatePlanningCandidatePayload(input),
        'taskVerification[0]',
      );
      expect(error.message).toContain(field);
    }
  });

  it('复用业务计划 v1 的 DAG 校验：重复 ID、缺依赖、自依赖、环的定位错误来自既有校验器', () => {
    const duplicate = validCandidateInput();
    (duplicate.plan as Record<string, unknown>).tasks = [
      { id: 't-1', title: 'A', acceptance: { criteria: ['a'] } },
      { id: 't-1', title: 'B', acceptance: { criteria: ['b'] } },
    ];
    expectFieldError(() => validatePlanningCandidatePayload(duplicate), 'tasks[1].id');

    const missing = validCandidateInput();
    (missing.plan as Record<string, unknown>).tasks = [
      { id: 't-1', title: 'A', acceptance: { criteria: ['a'] }, dependsOn: ['t-x'] },
    ];
    const missingError = expectFieldError(
      () => validatePlanningCandidatePayload(missing),
      'tasks[0].dependsOn[0]',
    );
    expect(missingError.details?.dependsOnTaskId).toBe('t-x');

    const self = validCandidateInput();
    (self.plan as Record<string, unknown>).tasks = [
      { id: 't-1', title: 'A', acceptance: { criteria: ['a'] }, dependsOn: ['t-1'] },
    ];
    expectFieldError(() => validatePlanningCandidatePayload(self), 'tasks[0].dependsOn[0]');

    const cycle = validCandidateInput();
    (cycle.plan as Record<string, unknown>).tasks = [
      { id: 't-1', title: 'A', acceptance: { criteria: ['a'] }, dependsOn: ['t-2'] },
      { id: 't-2', title: 'B', acceptance: { criteria: ['b'] }, dependsOn: ['t-1'] },
    ];
    const cycleError = captureValidationError(() => validatePlanningCandidatePayload(cycle));
    expect(cycleError.details?.field).toBe('tasks.dependencies');
    expect(cycleError.details?.cycle).toEqual(['t-1', 't-2', 't-1']);
  });

  it('候选内业务计划保持 feature.plan.import/revise 的 v1 输入语义：信封/聚合字段仍是未知键', () => {
    const input = validCandidateInput();
    (input.plan as Record<string, unknown>).expectedRevision = 3;
    const error = expectFieldError(() => validatePlanningCandidatePayload(input), 'input');
    expect(error.message).toContain('expectedRevision');
  });

  it('verification 意图负例：未知任务、重复条目、重复引用、非法形态、越界路径与数量上限', () => {
    const unknownTask = validCandidateInput();
    (unknownTask.taskVerification as Record<string, unknown>[])[0]!.taskId = 't-x';
    expectFieldError(
      () => validatePlanningCandidatePayload(unknownTask),
      'taskVerification[0].taskId',
    );

    const duplicateTask = validCandidateInput();
    (duplicateTask.taskVerification as Record<string, unknown>[])[1]!.taskId = 't-1';
    expectFieldError(
      () => validatePlanningCandidatePayload(duplicateTask),
      'taskVerification[1].taskId',
    );

    const dupRef = validCandidateInput();
    (dupRef.taskVerification as Record<string, unknown>[])[0]!.checkRefs = ['unit-core', 'unit-core'];
    expectFieldError(
      () => validatePlanningCandidatePayload(dupRef),
      'taskVerification[0].checkRefs[1]',
    );

    const badCheckKey = validCandidateInput();
    (badCheckKey.taskVerification as Record<string, unknown>[])[0]!.checkRefs = ['BadKey!'];
    expectFieldError(
      () => validatePlanningCandidatePayload(badCheckKey),
      'taskVerification[0].checkRefs[0]',
    );

    const badModule = validCandidateInput();
    (badModule.taskVerification as Record<string, unknown>[])[0]!.moduleRefs = ['has space'];
    expectFieldError(
      () => validatePlanningCandidatePayload(badModule),
      'taskVerification[0].moduleRefs[0]',
    );

    for (const [target, field] of [
      ['/etc/passwd', 'taskVerification[0].impactScope[0]'],
      ['../outside', 'taskVerification[0].impactScope[0]'],
      ['a\\b', 'taskVerification[0].impactScope[0]'],
      ['-watch', 'taskVerification[0].impactScope[0]'],
    ] as const) {
      const input = validCandidateInput();
      (input.taskVerification as Record<string, unknown>[])[0]!.impactScope = [target];
      expectFieldError(() => validatePlanningCandidatePayload(input), field);
    }

    const dupScope = validCandidateInput();
    (dupScope.taskVerification as Record<string, unknown>[])[0]!.impactScope = [
      'packages/core',
      'packages/core',
    ];
    expectFieldError(
      () => validatePlanningCandidatePayload(dupScope),
      'taskVerification[0].impactScope[1]',
    );

    const tooManyChecks = validCandidateInput();
    (tooManyChecks.taskVerification as Record<string, unknown>[])[0]!.checkRefs = Array.from(
      { length: PLANNING_TASK_CHECK_REFS_MAX_COUNT + 1 },
      (_, index) => `check-${index.toString().padStart(3, '0')}`,
    );
    expectFieldError(
      () => validatePlanningCandidatePayload(tooManyChecks),
      'taskVerification[0].checkRefs',
    );

    const tooManyModules = validCandidateInput();
    (tooManyModules.taskVerification as Record<string, unknown>[])[0]!.moduleRefs = Array.from(
      { length: PLANNING_TASK_MODULE_REFS_MAX_COUNT + 1 },
      (_, index) => `mod-${index.toString().padStart(3, '0')}`,
    );
    expectFieldError(
      () => validatePlanningCandidatePayload(tooManyModules),
      'taskVerification[0].moduleRefs',
    );

    const tooManyScope = validCandidateInput();
    (tooManyScope.taskVerification as Record<string, unknown>[])[0]!.impactScope = Array.from(
      { length: PLANNING_TASK_IMPACT_SCOPE_MAX_COUNT + 1 },
      (_, index) => `scope-${index.toString().padStart(3, '0')}`,
    );
    expectFieldError(
      () => validatePlanningCandidatePayload(tooManyScope),
      'taskVerification[0].impactScope',
    );
  });

  it('审批摘要负例：非字符串/空/全空白/超长', () => {
    for (const [summary, field] of [
      [123, 'summary'],
      ['', 'summary'],
      ['   ', 'summary'],
    ] as const) {
      const input = validCandidateInput();
      input.summary = summary;
      expectFieldError(() => validatePlanningCandidatePayload(input), field);
    }
    const input = validCandidateInput();
    input.summary = 'x'.repeat(2001);
    expectFieldError(() => validatePlanningCandidatePayload(input), 'summary');
  });

  it('身份绑定负例：缺失或非法 projectId/featureId/runId/candidateId', () => {
    for (const key of ['projectId', 'featureId', 'runId', 'candidateId'] as const) {
      const input = validCandidateInput();
      delete input[key];
      expectFieldError(() => validatePlanningCandidatePayload(input), key);
    }
  });

  it('错误脱敏：details 不回显输入正文，receivedType 只描述类型', () => {
    const input = validCandidateInput();
    input.summary = { secret: '不可回显的正文内容' };
    const error = captureValidationError(() => validatePlanningCandidatePayload(input));
    expect(error.kind).toBe('validation');
    expect(JSON.stringify(error.details)).not.toContain('不可回显的正文内容');
    expect(error.details?.receivedType).toBe('object');
  });
});

/* ------------------------------------------------------------------ *
 * 候选身份封装
 * ------------------------------------------------------------------ */

describe('P05-1 / F-001 规划候选身份封装', () => {
  it('生成前允许无 Artifact 引用：artifactRef 省略/null 归一为 null', () => {
    for (const artifactRef of [undefined, null]) {
      const input: Record<string, unknown> = {
        projectId: 'proj-1',
        featureId: 'feature-p05',
        runId: 'run-plan-1',
        candidateId: 'cand-0001',
      };
      if (artifactRef !== undefined) {
        input.artifactRef = artifactRef;
      }
      expect(validatePlanningCandidateIdentity(input)).toEqual({
        projectId: 'proj-1',
        featureId: 'feature-p05',
        runId: 'run-plan-1',
        candidateId: 'cand-0001',
        artifactRef: null,
      });
    }
  });

  it('携带 Artifact 引用时保留身份级引用（contentHash 可选）', () => {
    const identity = validatePlanningCandidateIdentity({
      projectId: 'proj-1',
      featureId: 'feature-p05',
      runId: 'run-plan-1',
      candidateId: 'cand-0001',
      artifactRef: { artifactId: 'art-cand-1', contentHash: 'b'.repeat(64) },
    });
    expect(identity.artifactRef).toEqual({ artifactId: 'art-cand-1', contentHash: 'b'.repeat(64) });

    const noHash = validatePlanningCandidateIdentity({
      projectId: 'proj-1',
      featureId: 'feature-p05',
      runId: 'run-plan-1',
      candidateId: 'cand-0001',
      artifactRef: { artifactId: 'art-cand-1' },
    });
    expect(noHash.artifactRef).toEqual({ artifactId: 'art-cand-1' });
  });

  it('负例：未知字段、非法 ID、非法 artifactRef 形态', () => {
    const extra = { projectId: 'p', featureId: 'f', runId: 'r', candidateId: 'c', extra: 1 };
    const error = expectFieldError(() => validatePlanningCandidateIdentity(extra), 'input');
    expect(error.message).toContain('extra');

    const badId = { projectId: 'p', featureId: '', runId: 'r', candidateId: 'c' };
    expectFieldError(() => validatePlanningCandidateIdentity(badId), 'featureId');

    const badHash = {
      projectId: 'p',
      featureId: 'f',
      runId: 'r',
      candidateId: 'c',
      artifactRef: { artifactId: 'a', contentHash: 'zz' },
    };
    expectFieldError(() => validatePlanningCandidateIdentity(badHash), 'artifactRef.contentHash');

    const notObject = { projectId: 'p', featureId: 'f', runId: 'r', candidateId: 'c', artifactRef: 'a' };
    expectFieldError(() => validatePlanningCandidateIdentity(notObject), 'artifactRef');
  });
});
