import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { boot, dateAfter } from '../plans/helpers.mjs';
import { installReactStub } from './support/react-stub.mjs';
import { byTestId, planGet, draftView } from '../onboarding/helpers.mjs';
import askTask from '../../client/actions/ask-task.js';
import { notifyStudyDataChanged, onStudyDataChanged } from '../../client/lib/refresh.js';

installReactStub();
const {PlanView}=await import('../../client/pages/plan.js');
const {WorkbenchView,runGuardedWrite}=await import('../../client/pages/workbench.js');
const create=(type,props,...children)=>({type,props:props??{},children});

test('SB-02: tool and UI share tasks, moved blocks and the progress ledger without a model',async t=>{
  const h=await boot(t);
  const draft=await h.ok('saveDraft',{baseRevision:0,expectedDraftRevision:0,title:'Local plan',
    availability:[{date:dateAfter(),minutes:120}],
    items:[{id:'math',title:'Math',estimateMinutes:60,date:dateAfter(),start:'09:00',end:'10:00'}]});
  await h.ok('confirm',{planId:draft.plan.id,baseRevision:0,expectedDraftRevision:draft.draft.draftRevision});
  const day=await h.ctx.study.call('tasks','day',{});
  const agent=await h.tool('study_tasks',{action:'day'});
  assert.deepEqual(agent,day.value);
  await h.tool('study_tasks',{action:'moveBlock',requestId:randomUUID(),payload:{id:agent.blocks[0].id,date:dateAfter(),start:'10:00',end:'11:00'}});
  assert.equal((await h.tool('study_plan',{action:'today'})).items[0].start,'10:00');
  await h.ok('recordProgress',{planId:draft.plan.id,itemId:'math',status:'done'});
  const progress=await h.ctx.study.call('tasks','progress',{taskId:agent.tasks[0].id,history:true});
  assert.equal(progress.value.records.length,1);
  assert.equal(progress.value.records[0].status,'done');
  const outcome=await h.ctx.study.call('outcomes','day',{goalId:'unassigned'});
  assert.equal(outcome.value.completion.adjusted.completed,1);

  let asked=false,started=false;
  const tree=WorkbenchView({create,t:key=>key,mode:'day',date:dateAfter(),view:{phase:'ready',value:day.value},
    taskDraft:{prerequisites:[]},blockDraft:null,progressDraft:null,onAskTask:()=>asked=true,onStartTask:()=>started=true});
  byTestId(tree,`workbench-ask-${agent.tasks[0].id}`).props.onClick();
  byTestId(tree,`workbench-start-${agent.tasks[0].id}`).props.onClick();
  assert.equal(asked,true);assert.equal(started,true);
});

test('SB-02: plan confirm/progress controls are reachable',()=>{
  const value=planGet(); value.draft=draftView();
  let confirmed=false,recorded;
  const tree=PlanView({create,t:key=>key,view:{phase:'ready',value,materials:[],progressItems:[]},
    onConfirm:()=>confirmed=true,onProgress:(item,status)=>recorded={item,status}});
  byTestId(tree,'plan-confirm').props.onClick();
  const item=value.applied.data.items[0];
  byTestId(tree,`plan-progress-${item.id}-done`).props.onClick();
  assert.equal(confirmed,true);assert.equal(recorded.item.id,item.id);assert.equal(recorded.status,'done');
});

test('SB-02: ask-task opens a session before linking and carries a write identity',async()=>{
  const calls=[];let opened;
  await askTask.run({taskId:'task-1',ensureSession:async()=>{calls.push('session');return 'sess-1';},
    openSession:id=>opened=id,call:async(ns,method,payload)=>{calls.push({ns,method,payload});return {ok:true,value:{status:'linked'}};}});
  assert.equal(calls[0],'session');
  assert.equal(calls[1].method,'open');assert.equal(calls[1].payload.sessionId,'sess-1');
  assert.equal(typeof calls[1].payload.requestId,'string');assert.equal(opened,'sess-1');
});

test('SB-02: a committed workbench write announces a mounted-surface refresh',async()=>{
  let announced=0;let reloaded=false;
  const off=onStudyDataChanged(reason=>{announced+=1;});
  try {
    const result=await runGuardedWrite({
      getView:()=>({phase:'ready',value:{blocks:[],tasks:[],summary:{study:{blockCount:0,minuteCount:0,taskCount:0},fixed:{blockCount:0,minuteCount:0,taskCount:0}},progress:{}},revision:1}),
      setView:()=>{},setStale:()=>{},setNotice:()=>{},
      call:async()=>({ok:true,value:{},revision:2}),
      load:async()=>{reloaded=true;},
      t:key=>key,
      busy:{current:false},
      kind:'progress.record',payload:{taskId:'t',status:'done'},
      build:()=>({method:'recordProgress',body:{taskId:'t',status:'done'},optimistic:null,refreshMode:'day',refreshDate:null}),
    });
    assert.equal(result.ok,true);assert.equal(reloaded,true);assert.equal(announced,1);
  } finally { off(); }
  notifyStudyDataChanged('after-unsubscribe');
  assert.equal(announced,1);
});
