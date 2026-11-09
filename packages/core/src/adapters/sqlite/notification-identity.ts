import type Database from 'better-sqlite3';

/** Resolve only same-project metadata and freeze it in the existing outbox. */
export function notificationIdentity(db: Database.Database, projectId: string,
  summary: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  const taskId = typeof summary.taskId === 'string' ? summary.taskId : null;
  const featureId = typeof summary.featureId === 'string' ? summary.featureId : null;
  const row = db.prepare(`SELECT p.display_name,ph.id phase_id,ph.title phase_title,
    f.id feature_id,f.title feature_title,t.title task_title,t.kind task_kind,
    pc.code phase_code,fc.code feature_code,tc.code task_code
    FROM features f JOIN projects p ON p.id=f.project_id
    JOIN phases ph ON ph.project_id=f.project_id AND ph.id=f.phase_id
    LEFT JOIN tasks t ON t.project_id=f.project_id AND t.feature_id=f.id AND t.id=@taskId
    LEFT JOIN entity_display_codes pc ON pc.project_id=f.project_id AND pc.entity_kind='phase' AND pc.entity_id=ph.id
    LEFT JOIN entity_display_codes fc ON fc.project_id=f.project_id AND fc.entity_kind='feature' AND fc.entity_id=f.id
    LEFT JOIN entity_display_codes tc ON tc.project_id=f.project_id AND tc.entity_kind='task' AND tc.entity_id=t.id
    WHERE f.project_id=@projectId AND f.id=coalesce(
      (SELECT feature_id FROM tasks WHERE project_id=@projectId AND id=@taskId),@featureId)`)
    .get({ projectId, taskId, featureId }) as {
      display_name: string; phase_id: string; phase_title: string; phase_code: string | null;
      feature_id: string; feature_title: string; feature_code: string | null;
      task_title: string | null; task_kind: string | null; task_code: string | null;
    } | undefined;
  if (!row) return undefined;
  // A supplied Task must belong to this project and Feature; never attach another
  // project's labels to an event carrying an unknown/mismatched identity.
  if ((taskId !== null && row.task_kind === null) || (featureId !== null && featureId !== row.feature_id)) return undefined;
  return { projectName: row.display_name.slice(0, 200), phaseId: row.phase_id,
    phaseCode: row.phase_code, phaseTitle: row.phase_title.slice(0, 100),
    featureId: row.feature_id, featureCode: row.feature_code, featureTitle: row.feature_title.slice(0, 100),
    ...(taskId === null ? {} : { taskKind: row.task_kind, taskTitle: row.task_title?.slice(0, 100),
      taskCode: row.task_kind === 'planning' && row.feature_code ? `${row.feature_code}-PLAN` : row.task_code }) };
}
