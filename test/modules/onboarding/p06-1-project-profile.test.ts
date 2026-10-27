import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_MODULE_SCHEMA_VERSION,
  DETECTION_EVIDENCE_SCHEMA_VERSION,
  PROJECT_PROFILE_SCHEMA_VERSION,
  PROFILE_DETECTION_STATUSES,
  PROFILE_CONFIRMATION_STATUSES,
  validateCapabilityModule,
  validateDetectionEvidence,
  validateProjectProfile,
  type ProjectProfileInspectionResult,
} from '../../../packages/core/src/ports/project-profile.ts';
import { createProjectProfileInspector } from '../../../packages/core/src/adapters/fs/project-profile-inspector.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-p06-profile-'));
  roots.push(root);
  return root;
}

function expectInvalid(run: () => unknown): void {
  expect(run).toThrowError(/schema|字段|ID|模块|秘密|正文|长度|版本|引用/);
}

describe('P06-1 ProjectProfile 与 CapabilityModule 契约', () => {
  it('接受带确认状态的版本化画像、证据和模块，并拒绝未知字段与版本', () => {
    const evidence = validateDetectionEvidence({
      schemaVersion: DETECTION_EVIDENCE_SCHEMA_VERSION,
      id: 'evidence-node',
      detectorId: 'node-static',
      detectorVersion: '1.0.0',
      source: 'package.json',
      summary: '检测到 Node.js 项目清单',
      status: 'candidate',
      confirmed: false,
    });
    expect(evidence.confirmed).toBe(false);

    const module = validateCapabilityModule({
      schemaVersion: CAPABILITY_MODULE_SCHEMA_VERSION,
      id: 'language-node',
      version: '1.0.0',
      scope: ['language:node'],
      appliesTo: ['node'],
      dependencies: [],
      contentRef: 'builtin:language-node@1.0.0',
      status: 'candidate',
    });
    expect(module.status).toBe('candidate');

    const profile = validateProjectProfile({
      schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
      projectId: 'project-1',
      version: 1,
      status: 'candidate',
      modules: [{
        id: 'language-node',
        version: '1.0.0',
        roots: ['.'],
        languages: ['node'],
        frameworks: [],
        capabilityRefs: ['language-node@1.0.0'],
        checkRefs: [],
      }],
      documentRefs: [],
      detectionEvidenceRefs: ['evidence-node'],
      confirmedBy: null,
    });
    expect(profile.status).toBe('candidate');

    for (const bad of [
      { ...profile, schemaVersion: 99 },
      { ...profile, extra: 'body' },
      { ...profile, modules: [...profile.modules, profile.modules[0]] },
      { ...module, id: '../secret' },
      { ...module, token: 'SECRET' },
      { ...evidence, body: 'full source text' },
      { ...evidence, detectorVersion: 'x'.repeat(129) },
    ]) {
      expectInvalid(() => {
        if ('detectorId' in bad) validateDetectionEvidence(bad);
        else if ('contentRef' in bad) validateCapabilityModule(bad);
        else validateProjectProfile(bad);
      });
    }
  });

  it('保留四类确认状态，候选检测不会成为已确认事实', () => {
    expect([...PROFILE_DETECTION_STATUSES]).toEqual([
      'candidate',
      'confirmed',
      'rejected',
      'manual_configuration_required',
    ]);
    expect([...PROFILE_CONFIRMATION_STATUSES]).toEqual(PROFILE_DETECTION_STATUSES);
  });
});

describe('P06-1 只读静态技术检测', () => {
  it('从真实临时仓库识别 Node/TypeScript 与 Python，带脱敏证据且不执行 package 脚本', async () => {
    const root = await tempProject();
    const sentinel = join(root, 'script-ran');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad')"` },
    }));
    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    await writeFile(join(root, 'src/index.ts'), 'export const value = 1;');
    await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "fixture"\n');
    await writeFile(join(root, 'src/tool.py'), 'print("fixture")\n');
    await writeFile(join(root, 'README.xyz'), 'unknown language');

    const result = await createProjectProfileInspector().inspect(root);
    expect(result.schemaVersion).toBe(1);
    expect(result.detections.map((item) => item.key)).toEqual(
      expect.arrayContaining(['node', 'typescript', 'python']),
    );
    for (const detection of result.detections) {
      expect(detection.status).not.toBe('confirmed');
      expect(detection.confirmed).toBe(false);
      expect(detection.evidence.length).toBeGreaterThan(0);
      for (const evidence of detection.evidence) {
        expect(evidence.detectorVersion).toBe('1.0.0');
        expect(evidence.summary).not.toContain('postinstall');
        expect(evidence.summary).not.toContain('print(');
        expect(evidence.source).not.toMatch(/^\//);
        expect(evidence).not.toHaveProperty('content');
      }
    }
    expect(result.uncertainties.some((item) => item.reason === 'unknown_language')).toBe(true);
    expect(result.detections).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'unknown', status: 'manual_configuration_required', confirmed: false }),
    ]));
    expect(result.candidateProfile.status).toBe('candidate');
    expect(result.candidateProfile.confirmedBy).toBeNull();
    expect(result.candidateProfile.detectionEvidenceRefs.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('canonicalPath');
    expect(result).not.toHaveProperty('repositoryPath');
    expect(result).not.toHaveProperty('packageScripts');
    expect(result).not.toHaveProperty('fileContents');
    await expect(import('node:fs/promises').then(({ access }) => access(sentinel))).rejects.toThrow();
  });

  it('空仓库、缺失或不可读清单返回结构化不确定结果，不伪造识别', async () => {
    const root = await tempProject();
    const result: ProjectProfileInspectionResult = await createProjectProfileInspector().inspect(root);
    expect(result.detections).toHaveLength(0);
    expect(result.uncertainties).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'missing_file' }),
    ]));
    expect(result.candidateProfile.status).toBe('manual_configuration_required');
    expect(result.candidateProfile.modules).toHaveLength(0);
  });
});
