import type { SqliteStorageSession } from './session.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import type { ArtifactInputRef } from '../../ports/artifact-store.js';
import type { IntegrationVerificationEvidenceRef } from '../../ports/integration-verification.js';
import type { IntegrationRepairVerificationRecord } from '../../ports/integration-repair-verification.js';
import { StorageError } from '../../ports/errors.js';
import { validateSha256Digest, validateStableId } from '../../ports/validation.js';

export function createSqliteIntegrationRepairVerifications(session: SqliteStorageSession, options:{nowUtcMs?:()=>number}={}) {
  const db=session.database, now=options.nowUtcMs??Date.now, atomic=createSqliteAtomicCommandStore(session,{nowUtcMs:now});
  function fail(reason:string):never { throw new StorageError('conflict','IntegrationRepairVerification',reason,{details:{reason}}); }
  function readRow(projectId:string,repairId:string) { return db.prepare('SELECT * FROM integration_repair_verifications WHERE project_id=? AND repair_id=?').get(projectId,repairId) as any; }
  function decode(row:any):IntegrationRepairVerificationRecord {
    if (!row) fail('verification_not_found');
    const artifact=JSON.parse(row.artifact_ref) as ArtifactInputRef;
    const planRef=JSON.parse(row.plan_ref) as IntegrationVerificationEvidenceRef;
    const resultRef=JSON.parse(row.result_ref) as IntegrationVerificationEvidenceRef;
    if (artifact.projectId!==row.project_id || artifact.artifactId!==row.artifact_id || row.status!=='passed') fail('verification_corrupt');
    validateSha256Digest(artifact.contentHash,{operation:'IntegrationRepairVerification'},'artifact.contentHash');
    validateStableId(planRef.id,{operation:'IntegrationRepairVerification'},'planRef.id');
    validateStableId(resultRef.id,{operation:'IntegrationRepairVerification'},'resultRef.id');
    validateSha256Digest(planRef.digest,{operation:'IntegrationRepairVerification'},'planRef.digest');
    validateSha256Digest(resultRef.digest,{operation:'IntegrationRepairVerification'},'resultRef.digest');
    validateSha256Digest(row.input_digest,{operation:'IntegrationRepairVerification'},'inputDigest');
    return {projectId:row.project_id,repairId:row.repair_id,attemptId:row.attempt_id,artifact,planRef,resultRef,inputDigest:row.input_digest,status:'passed'};
  }
  return {
    read(projectId:string,repairId:string){return atomic.transact('IntegrationRepairVerification.read',()=>decode(readRow(projectId,repairId)));},
    bind(tx:CommandTransaction,value:{projectId:string;repairId:string;attemptId:string;artifact:ArtifactInputRef;planRef:IntegrationVerificationEvidenceRef;resultRef:IntegrationVerificationEvidenceRef;inputDigest:string}) {
      if (!session.database.inTransaction) throw new TypeError('IntegrationRepairVerification.bind requires transaction');
      const prior=readRow(value.projectId,value.repairId); if (prior) {
        const existing=decode(prior); if (existing.attemptId!==value.attemptId || existing.inputDigest!==value.inputDigest
          || JSON.stringify(existing.planRef)!==JSON.stringify(value.planRef) || JSON.stringify(existing.resultRef)!==JSON.stringify(value.resultRef)) fail('verification_identity_conflict');
        return existing;
      }
      db.prepare(`INSERT INTO integration_repair_verifications(project_id,repair_id,attempt_id,artifact_id,artifact_ref,plan_ref,result_ref,input_digest,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(value.projectId,value.repairId,value.attemptId,value.artifact.artifactId,JSON.stringify(value.artifact),JSON.stringify(value.planRef),JSON.stringify(value.resultRef),value.inputDigest,'passed',now());
      return decode(readRow(value.projectId,value.repairId));
    },
  };
}
