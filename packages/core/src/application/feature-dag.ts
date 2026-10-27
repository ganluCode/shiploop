/**
 * Feature DAG 应用入口。
 *
 * 外层 Feature DAG 的规则保持纯函数，便于命令、查询和 SQLite 事务分别复用；
 * 本模块提供应用层稳定入口，避免调用方依赖具体存储实现。
 */
export {
  createFeatureDagService,
  deriveFeatureDagReadiness,
  detectFeatureDependencyCycle,
  evaluateFeatureDag,
  validateFeatureDag,
} from '../ports/feature-dag.js';
