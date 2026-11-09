import { expect,it } from 'vitest';
import { openF007Fixture,F007_STANDARD_STEPS } from '../../helpers/planning/p05-1-f007-fixture.ts';

it.each([false,true])('renews the entire active planning occupancy without reviving expired leases (%s)',async expired=>{
  const f=await openF007Fixture({prefix:'planning-heartbeat-',skipSeedWorkspace:true,steps:F007_STANDARD_STEPS});
  try{
    await f.core.workExecution.scan();
    await f.waitForExecutingState();
    const db=f.session.database;
    const attempt=f.query('SELECT * FROM attempts WHERE run_id=?',f.planningRunId);
    const before=Number(attempt.lease_until);
    if(expired){
      db.prepare('UPDATE workspace_leases SET lease_until=0 WHERE owner_id=?').run(attempt.id);
      db.prepare('UPDATE attempts SET lease_until=0 WHERE id=?').run(attempt.id);
    }
    const heartbeat=await f.core.workExecution.heartbeat();
    const leases=db.prepare('SELECT state,lease_until FROM workspace_leases WHERE owner_id=?').all(attempt.id) as {state:string;lease_until:number}[];
    expect(leases).toHaveLength(3);
    if(expired){
      expect(heartbeat.quarantined).toBe(1);
      expect(leases.every(lease=>lease.state==='quarantined'&&lease.lease_until===0)).toBe(true);
    }else{
      expect(heartbeat.failed).toBe(0);
      const until=Number(f.query('SELECT lease_until FROM attempts WHERE id=?',attempt.id).lease_until);
      expect(until).toBeGreaterThan(before);
      expect(leases.every(lease=>lease.state==='held'&&lease.lease_until===until)).toBe(true);
      expect(await f.submitCandidate(f.candidateBody())).toMatchObject({status:'completed'});
    }
  }finally{f.gate.release();await f.close();}
},60000);
