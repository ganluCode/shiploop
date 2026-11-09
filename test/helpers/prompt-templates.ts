import { loadBuiltinPromptTemplates } from '../../packages/core/src/adapters/fs/prompt-templates.ts';

export const testPromptTemplates = loadBuiltinPromptTemplates('zh-CN');
export const CONTEXT_FIXED_GUIDANCE = testPromptTemplates.render('task/guidance.md');
export const CONTEXT_REWORK_GUIDANCE = testPromptTemplates.render('task/rework-guidance.md');
export const PLANNING_FIXED_GUIDANCE = testPromptTemplates.render('planner/guidance.md');
