/**
 * F-010 授权查询/一致读视图/事件分页窄读取端口的 SQLite 装配（adapters 层）。
 *
 * 依据 docs/p02-2-commands-events-contract.md §7/§8/§9.3：
 * - listVisibleProjects / countVisibleProjectLabels：可见范围谓词下推 SQL
 *   （先收窄再分页/计数），复用 P01 标签筛选/键集分页的同一 SQL 构建器；
 * - readProjectSnapshotView / readGlobalSnapshotView：§8 一致读视图——同一
 *   BEGIN DEFERRED 读事务内取得内容行与 MAX(state_events.sequence) 水位；
 * - listPersistedEvents：持久 state_events 是唯一事件来源，scope 谓词下推，
 *   sequence 升序、排他下界、每批有界；F-012 起 findPersistedEventSequence
 *   在同一 scope 谓词内把 Last-Event-ID 解析为持久 sequence（未命中即
 *   undefined，不区分不存在与跨 scope）。
 *
 * 全部实现共享 createSqliteStateAccess 的行映射/校验/事件原语，不另立第二套
 * 规则；import 本模块无副作用，会话生命周期由调用方管理，返回面不泄漏驱动句柄。
 */
import type { StateEventReadStore } from '../../ports/events.js';
import type { PersistedStateEventRow } from '../../ports/events.js';
import type {
  AuthorizedProjectReadStore,
  ConsistentSnapshotStore,
  SnapshotView,
} from '../../ports/queries.js';
import type { ProjectLabelCount, ProjectPage } from '../../ports/state-store.js';
import type { SqliteStorageSession } from './session.js';
import { createSqliteStateAccess } from './state-store.js';
import type { SqliteStateStoreOptions } from './state-store.js';

/** F-010 查询读取门面：三个窄端口的并集（应用层 QueryService 的消费面）。 */
export interface SqliteQueryStore
  extends AuthorizedProjectReadStore,
    ConsistentSnapshotStore,
    StateEventReadStore {}

export function createSqliteQueryStore(
  session: SqliteStorageSession,
  options: SqliteStateStoreOptions = {},
): SqliteQueryStore {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('createSqliteQueryStore: session 必须是 SqliteStorageSession');
  }
  const access = createSqliteStateAccess(session, options);
  return {
    listVisibleProjects(visibility: unknown, filter: unknown): ProjectPage {
      return access.listVisibleProjects(visibility, filter);
    },
    countVisibleProjectLabels(visibility: unknown): readonly ProjectLabelCount[] {
      return access.countVisibleProjectLabels(visibility);
    },
    readProjectSnapshotView(projectId: unknown): SnapshotView {
      return access.readProjectSnapshotView(projectId);
    },
    readGlobalSnapshotView(): SnapshotView {
      return access.readGlobalSnapshotView();
    },
    listPersistedEvents(request: unknown): readonly PersistedStateEventRow[] {
      return access.listPersistedEvents(request);
    },
    findPersistedEventSequence(request: unknown): number | undefined {
      return access.findPersistedEventSequence(request);
    },
  };
}
