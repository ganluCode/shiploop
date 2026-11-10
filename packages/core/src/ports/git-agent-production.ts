import type { CommandProcessIdentity } from './command-process.js';
import type { GitAgentRuntimeAdapter, GitAgentRuntimeRequest, GitAgentRuntimeResult } from './git-agent-runtime.js';
import type { RuntimeExecutionRequest, RuntimeUsageReport } from './runtime-execution.js';
import type { RuntimeStrategyV1 } from './settings-schema.js';
import type { WorkflowLocale } from './locale.js';

export interface ProductionGitAgentBinding {
  readonly requestDigest: string;
  readonly strategy: RuntimeStrategyV1;
  readonly cwd: RuntimeExecutionRequest['cwd'];
  readonly workspaceRoots: Readonly<Record<string,string>>;
  readonly locale: WorkflowLocale;
  readonly intent: string;
  readonly evidence: string;
  readonly maxRequests: number;
}
export interface ProductionGitAgentRecord {
  readonly requestDigest: string;
  readonly execution: GitAgentRuntimeRequest['execution'];
  readonly result: GitAgentRuntimeResult;
  readonly events: readonly {readonly sequence:number;readonly kind:string}[];
  readonly hold:'stop_unconfirmed'|null;
  readonly reportedUsage:RuntimeUsageReport|null;
  readonly reportedDurationMs:number|null;
}
export interface ProductionGitAgentAuthority {
  resolve(request:GitAgentRuntimeRequest):Promise<ProductionGitAgentBinding>;
  assertCurrent(request:GitAgentRuntimeRequest):Promise<void>;
  confirmProcess(identity:CommandProcessIdentity,request:GitAgentRuntimeRequest):Promise<{launchId:string}>;
  inspectCandidate(request:GitAgentRuntimeRequest):Promise<readonly string[]>;
  record(record:ProductionGitAgentRecord):Promise<void>;
}
/** Trusted Host injection only; never a setting, model tool or command argument. */
export type ProductionGitAgentRuntimeFactory=(authority:ProductionGitAgentAuthority)=>GitAgentRuntimeAdapter;
