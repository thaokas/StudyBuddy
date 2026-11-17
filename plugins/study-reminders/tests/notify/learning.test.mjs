import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLearningNotifier } from '../../client/learning-notify.js';
import { memoryArea } from './support.mjs';

test('learning notices share reminder keys and persist deduplication across reloads', () => {
  const sent=[]; const storage=memoryArea();
  class Notification { static permission='granted'; constructor(title,options){sent.push({title,...options});} }
  const notifier=createLearningNotifier({env:{Notification},storage});
  const item={key:'block:b1',title:'Math',state:'shown',start:'09:00',end:'10:00'};
  notifier.reminders([item]); notifier.reminders([item]);
  createLearningNotifier({env:{Notification},storage}).reminders([item]);
  notifier.reminders([{...item,key:'block:b2',state:'answered'}]);
  assert.deepEqual(sent.map(n=>n.tag),['block:b1']);
});

test('denied permission and notification errors preserve the in-app path', async () => {
  class Notification { static permission='denied'; static async requestPermission(){throw Error('denied');} constructor(){throw Error('unsupported');} }
  const notifier=createLearningNotifier({env:{Notification},storage:memoryArea()});
  assert.equal(notifier.notify('block:b1','Math',''),false);
  assert.equal(await notifier.requestPermission(),'denied');
  Notification.permission='granted';
  assert.equal(notifier.notify('block:b2','Math',''),false);
});

test('a denied notice does not consume its reminder key when permission is granted later', () => {
  const sent=[];
  class Notification { static permission='denied'; constructor(_title,options){sent.push(options.tag);} }
  const notifier=createLearningNotifier({env:{Notification},storage:memoryArea()});
  assert.equal(notifier.notify('block:b1','Math',''),false);
  Notification.permission='granted';
  assert.equal(notifier.notify('block:b1','Math',''),true);
  assert.equal(notifier.notify('block:b1','Math',''),false);
  assert.deepEqual(sent,['block:b1']);
});

test('only naturally completed pomodoros notify, once per timer', () => {
  const sent=[];
  class Notification { static permission='granted'; constructor(_title,options){sent.push(options.tag);} }
  const notifier=createLearningNotifier({env:{Notification},storage:memoryArea()});
  notifier.timer({id:'t1',phase:'running'});
  notifier.timer({id:'t1',phase:'finished',outcome:'ended'});
  notifier.timer({id:'t2',phase:'finished',outcome:'completed'});
  notifier.timer({id:'t2',phase:'finished',outcome:'completed'});
  assert.deepEqual(sent,['timer:t2']);
});
