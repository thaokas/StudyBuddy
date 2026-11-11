import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootFollowup, createClock } from './helpers.mjs';

async function fixture(t, options) {
  const h=await bootFollowup(t,options);
  const task=await h.createTask('Math');
  const block=await h.createBlock({taskId:task.id,date:h.today(),start:'09:00',end:'10:00'});
  return {h,task,block};
}

test('SB-06 starts do not remind; the end is due and claim/answer are idempotent',async t=>{
  const {h,task,block}=await fixture(t);
  h.advance(60*60_000);
  assert.equal((await h.followup('due')).newItems.length,0);
  h.advance(60*60_000);
  const due=await h.followup('due');
  assert.equal(due.newItems.length,1);
  assert.equal(due.newItems[0].key,`block:${block.id}`);
  assert.equal(due.newItems[0].overdueMinutes,0);
  const key=due.newItems[0].key;
  assert.equal((await h.followup('claim',{keys:[key]})).claimed.length,1);
  assert.equal((await h.followup('claim',{keys:[key]})).claimed.length,0);
  assert.equal((await h.followup('due')).pendingItems.length,1);
  assert.equal((await h.followup('answer',{key,reply:'done'})).progress.record.status,'done');
  const ledger=await h.ok('tasks','day',{date:h.today()});
  assert.equal(ledger.progress[task.id].status,'done','the quick reply writes the shared task ledger');
  assert.equal((await h.followup('answer',{key,reply:'done'})).duplicate,true);
  assert.equal((await h.followup('due')).pendingItems.length,0);
  assert.equal(h.database.get('SELECT count(*) n FROM study_followup_reminder').n,1);
});

test('SB-06 two blocks of the same task retain independent keys, replies and due minutes',async t=>{
  const h=await bootFollowup(t);const task=await h.createTask('Math');
  const b1=await h.createBlock({taskId:task.id,date:h.today(),start:'09:00',end:'09:30'});
  const b2=await h.createBlock({taskId:task.id,date:h.today(),start:'09:40',end:'10:10'});
  h.advance(100*60_000);
  const early=await h.followup('due');
  assert.deepEqual(early.newItems.map(i=>i.blocks.map(b=>b.id)),[[b1.id]]);
  assert.equal(early.newItems[0].minutes,30);
  assert.equal(early.newItems[0].overdueMinutes,10);
  await h.followup('claim');
  await h.followup('answer',{key:`block:${b1.id}`,reply:'done'});
  h.advance(40*60_000);
  const later=await h.followup('due');
  assert.deepEqual(later.newItems.map(i=>i.key),[`block:${b2.id}`]);
  await h.followup('claim');
  await h.followup('answer',{key:`block:${b2.id}`,reply:'partial'});
  assert.equal(h.database.get("SELECT outcome FROM study_followup_reminder WHERE key=?",`block:${b1.id}`).outcome,'done');
});

test('quiet hours, focus and snooze postpone without consuming an extra ask',async t=>{
  const {h}=await fixture(t);
  await h.followup('updateSettings',{quietStart:'09:00',quietEnd:'10:10'});
  h.advance(120*60_000);
  assert.equal((await h.followup('claim')).claimed.length,0);
  assert.equal((await h.followup('due')).deferredItems.length,1);
  h.advance(10*60_000);
  await h.ok('timer','start',{minutes:10});
  assert.equal((await h.followup('claim')).claimed.length,0);
  h.advance(10*60_000);
  const claimed=await h.followup('claim');
  assert.equal(claimed.claimed.length,1);
  const key=claimed.claimed[0].key;
  await h.followup('snooze',{key});
  assert.equal((await h.followup('due')).pendingItems.length,0);
  h.advance(10*60_000);
  assert.equal((await h.followup('due')).pendingItems.length,1);
  assert.equal(h.database.get('SELECT count(*) n FROM study_followup_reminder').n,1);
});

test('latest terminal or pending progress suppresses reminders',async t=>{
  const {h,task}=await fixture(t);h.advance(120*60_000);
  for(const record of [{status:'done'},{status:'cancelled'},{status:'partial',confirmed:false}]) {
    await h.ok('tasks','recordProgress',{taskId:task.id,...record});
    assert.equal((await h.followup('due')).newItems.length,0);
  }
});

test('restart and suspension skip missed ends; a future end may still remind',async t=>{
  let {h}=await fixture(t);
  h.jump(130*60_000);h.heartbeat();
  assert.equal((await h.followup('due')).newItems.length,0);
  h=await h.restart(createClock(new Date(2026,10,10,10,20)));
  assert.equal((await h.followup('due')).newItems.length,0);
  const task=await h.createTask('Later');
  await h.createBlock({taskId:task.id,date:h.today(),start:'10:00',end:'11:00'});
  h.advance(40*60_000);
  assert.equal((await h.followup('due')).newItems.length,1);
});

test('invalid claim keys do not create records; failed progress leaves reminder unanswered',async t=>{
  const {h,task}=await fixture(t);h.advance(120*60_000);
  assert.equal((await h.followup('claim',{keys:['unknown']})).claimed.length,0);
  const key=(await h.followup('claim')).claimed[0].key;
  await h.ok('tasks','deleteTask',{id:task.id});
  await h.followupFail('answer',{key,reply:'done'});
  assert.equal(h.database.get('SELECT state FROM study_followup_reminder WHERE key=?',key).state,'shown');
});
