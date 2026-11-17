import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCENES, STATUS_SCENES, VOICE, linesFor, voiceLocale } from '../client/lines.js';

const REQUIRED_SCENES = [
  'idle', 'think', 'working', 'done', 'error', 'rest', 'sleep',
  'click', 'pat', 'chatter', 'timerStart', 'timerFinish', 'greet',
];

describe('pet voice lines', () => {
  it('defines exactly the required scene set in both languages', () => {
    assert.deepEqual([...SCENES].sort(), [...REQUIRED_SCENES].sort());
    assert.deepEqual(Object.keys(VOICE.zh).sort(), [...REQUIRED_SCENES].sort());
    assert.deepEqual(Object.keys(VOICE.en).sort(), [...REQUIRED_SCENES].sort());
    assert.deepEqual(Object.keys(VOICE.zh).sort(), Object.keys(VOICE.en).sort());
    assert.ok(STATUS_SCENES.every(scene => REQUIRED_SCENES.includes(scene)));
  });

  it('keeps every scene pool between four and eight frozen lines', () => {
    for (const locale of ['zh', 'en']) {
      for (const scene of REQUIRED_SCENES) {
        const pool = VOICE[locale][scene];
        assert.ok(Array.isArray(pool), `${locale}.${scene} is a pool`);
        assert.ok(Object.isFrozen(pool), `${locale}.${scene} is frozen`);
        assert.ok(pool.length >= 4 && pool.length <= 8, `${locale}.${scene} has ${pool.length} lines`);
      }
    }
  });

  it('has no empty, placeholder, multiline or over-long line', () => {
    for (const locale of ['zh', 'en']) {
      for (const scene of REQUIRED_SCENES) {
        for (const [index, line] of VOICE[locale][scene].entries()) {
          const where = `${locale}.${scene}[${index}]`;
          assert.equal(typeof line, 'string', `${where} is a string`);
          assert.notEqual(line.trim(), '', `${where} is not empty`);
          assert.ok(!/[{}]/.test(line), `${where} has no placeholder braces`);
          assert.ok(!/[\r\n]/.test(line), `${where} is one line`);
          assert.ok(!/TODO|FIXME|undefined|null/.test(line), `${where} has no scaffolding text`);
          const limit = locale === 'zh' ? 48 : 96;
          assert.ok(line.length <= limit, `${where} is ${line.length} chars (limit ${limit})`);
        }
      }
    }
  });

  it('reads one pool and degrades unknown scenes/locales safely', () => {
    assert.equal(linesFor('zh', 'idle'), VOICE.zh.idle);
    assert.deepEqual(linesFor('zh', 'nope'), []);
    assert.deepEqual(linesFor('xx', 'idle'), VOICE.en.idle);
    assert.equal(voiceLocale('zh'), 'zh');
    assert.equal(voiceLocale('zh-CN'), 'zh');
    assert.equal(voiceLocale('en-US'), 'en');
    assert.equal(voiceLocale(undefined), 'en');
    assert.equal(voiceLocale('ja'), 'en');
  });
});
