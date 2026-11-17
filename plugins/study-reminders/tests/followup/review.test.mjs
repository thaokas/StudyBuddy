import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootFollowup } from './helpers.mjs';

async function seed(t,{quantity=true,minutes=60,capacity=30,status='partial',confirmed=true,unscheduled=false}={}) {
  const h=await bootFollowup(t);
  const plan=await h.createPlan({title:'Review',availability:[{date:h.today(),minutes:120},{date:h.date(1),minutes:capacity},{date:h.date(2),minutes:capacity}],
    items:[{id:'math',title:'Math',estimateMinutes:minutes,date:unscheduled?null:h.today(),start:unscheduled?null:'19:00',end:unscheduled?null:'20:00',flexible:true}]});
  const planId=plan.plan.id;
  if(status) await h.recordPlanProgress({planId,itemId:'math',status,confirmed,...(quantity?{quantityDone:5,quantityTotal:10}:{})});
  return {h,planId};
}

test('SB-04 two reviews of 60 minutes at 5/10 keep a 30-minute remainder and the original estimate',async t=>{
  const {h,planId}=await seed(t);
  const first=await h.followup('reviewPreview');
  assert.equal(first.summary.remainingMinutes,30);
  assert.equal((await h.followup('review',{planId,baseRevision:first.baseRevision})).committed,true);
  const data=(await h.plan(planId)).applied.data;
  assert.equal(data.items[0].estimateMinutes,60);
  // The next day has arrived, with no new progress.
  h.advance(24*60*60_000);
  const second=await h.followup('reviewPreview');
  assert.equal(second.summary.remainingMinutes,30);
  const repeated=await h.followup('reviewPreview');
  assert.deepEqual(repeated.proposal,second.proposal);
});

test('SB-04 a 60-minute remainder splits into two real 30-minute execution blocks',async t=>{
  const {h,planId}=await seed(t,{quantity:false,status:'not_started'});
  const preview=await h.followup('reviewPreview');
  assert.deepEqual(preview.proposal.moves.map(m=>m.minutes),[30,30]);
  assert.deepEqual(preview.proposal.moves.map(m=>m.date),[h.date(1),h.date(2)]);
  assert.equal((await h.followup('review',{planId,baseRevision:preview.baseRevision})).committed,true);
  const data=(await h.plan(planId)).applied.data;
  assert.equal(data.items.length,1);
  assert.equal(data.items[0].blocks.length,2);
  assert.equal(new Set(data.items[0].blocks.map(b=>b.taskId)).size,1);
  // Each execution day reads the same task from the live projection.
  for(const date of [h.date(1),h.date(2)]) {
    const day=await h.ok('plans','today',{planId,date});
    assert.equal(day.items.length,1);
    assert.equal(day.items[0].id,'math');
    assert.equal(day.items[0].taskId,data.items[0].taskId);
  }
});

test('SB-04 unrecorded and pending progress create tentative blocks and confirmation cleans them',async t=>{
  const {h,planId}=await seed(t,{status:null,quantity:false});
  const preview=await h.followup('reviewPreview');
  assert.ok(preview.proposal.moves.every(m=>m.tentative&&m.assumption));
  await h.followup('review',{planId,baseRevision:preview.baseRevision});
  assert.equal((await h.plan(planId)).applied.data.items[0].blocks.length,2);
  await h.recordPlanProgress({planId,itemId:'math',status:'done'});
  assert.equal((await h.plan(planId)).applied.data.items[0].blocks.length,0);
  assert.equal((await h.followup('reviewPreview')).status,'nothing_to_do');
});

test('SB-04 unscheduled work stays eligible; insufficient capacity retains a written remainder',async t=>{
  const {h,planId}=await seed(t,{quantity:false,status:'not_started',capacity:10,unscheduled:true});
  const preview=await h.followup('reviewPreview');
  assert.equal(preview.summary.movedMinutes,20);
  assert.equal(preview.summary.unscheduledMinutes,40);
  assert.ok(preview.proposal.explanations.length);
  assert.equal((await h.followup('review',{planId,baseRevision:preview.baseRevision})).committed,true);
  const detail=await h.plan(planId);
  assert.equal(detail.applied.data.items[0].unscheduledMinutes,40);
  // The saved plan must not look fully scheduled: the 40-minute remainder is
  // visible in capacity, plan counts and progress totals after a reload.
  assert.equal(detail.capacity.verdict,'partial');
  assert.equal(detail.capacity.totals.scheduledMinutes,20);
  assert.equal(detail.capacity.totals.unscheduledMinutes,40);
  assert.equal(detail.capacity.unscheduled.minutes,40);
  assert.deepEqual(detail.capacity.unscheduled.items.map(item=>item.id),['math']);
  assert.equal(detail.plan.counts.unscheduledMinutes,40);
  assert.equal(detail.plan.counts.partialUnscheduledItems,1);
  assert.equal(detail.progress.minutes.scheduled,20);
  assert.equal(detail.progress.minutes.unscheduled,40);
});

test('SB-04 an unconfirmed done statement remains tentative and repeated review creates no duplicates',async t=>{
  const {h,planId}=await seed(t,{quantity:false,status:'done',confirmed:false});
  const first=await h.followup('reviewPreview');
  assert.equal(first.summary.remainingMinutes,60);
  assert.ok(first.proposal.moves.every(move=>move.tentative&&move.sourceProgressRevision>0));
  await h.followup('review',{planId,baseRevision:first.baseRevision});
  const count=h.database.get('SELECT count(*) n FROM study_time_block').n;
  const second=await h.followup('reviewPreview');
  assert.equal(second.status,'nothing_to_do');
  await h.followup('review',{planId,baseRevision:second.baseRevision});
  assert.equal(h.database.get('SELECT count(*) n FROM study_time_block').n,count);
});

test('SB-07 a pending manual draft blocks review; stale review never announces success',async t=>{
  const {h,planId}=await seed(t);
  const stale=await h.followup('review',{planId,baseRevision:0});
  assert.equal(stale.committed,false);assert.equal(stale.status,'needs_adjustment');
  assert.equal((await h.followup('reviewStatus')).review.status,'needs_adjustment');
  const data=(await h.plan(planId)).applied.data;
  await h.ok('plans','saveDraft',{...data,planId,baseRevision:1,expectedDraftRevision:0});
  const blocked=await h.followup('review',{planId,baseRevision:1});
  assert.equal(blocked.committed,false);assert.equal(blocked.status,'blocked');
});

test('SB-07 Host checks and manual review services work without mounting a page',async t=>{
  const {h}=await seed(t);
  h.advance(14*60*60_000);
  const result=await h.followup('runReview');
  assert.equal(result.status,'ready');
  assert.equal((await h.plan()).plan.revision,1,'manual decision B never auto-saves');
  const recovery=await h.followup('recovery');
  assert.equal(recovery.reviewDecision,'manual_confirmation');
  assert.equal(recovery.scheduling.status,'degraded');
});
