import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUBBLE_TTL_MS,
  CHATTER_RANGE_MS,
  DREAM_RANGE_MS,
  SCENE_COOLDOWN_MS,
  createBubbleController,
  voiceForLocale,
} from '../client/bubble.js';
import { VOICE } from '../client/lines.js';

/**
 * Build one controller with a deterministic random source.
 * @param {() => number} [random] - Random source.
 * @returns {object} Controller.
 */
function controller(random = () => 0) {
  return createBubbleController({
    voice: voiceForLocale(VOICE, 'zh-CN'),
    random,
  });
}

describe('pet bubble controller', () => {
  it('shows a four-second bubble and expires it', () => {
    const bubbles = controller();
    const first = bubbles.say('click', 0, { kind: 'gesture', force: true });
    assert.equal(first.text, VOICE.zh.click[0]);
    assert.equal(first.kind, 'gesture');
    assert.equal(first.scene, 'click');
    assert.equal(first.expiresAt, BUBBLE_TTL_MS);

    const alive = bubbles.tick(BUBBLE_TTL_MS - 1);
    assert.equal(alive.expired, false);
    assert.equal(alive.bubble?.id, first.id);

    const dead = bubbles.tick(BUBBLE_TTL_MS);
    assert.equal(dead.expired, true);
    assert.equal(dead.bubble, null);
    assert.equal(bubbles.current(), null);
  });

  it('applies the nine-second same-scene cooldown and lets force through', () => {
    const bubbles = controller();
    assert.notEqual(bubbles.say('working', 0), null);
    assert.equal(bubbles.say('working', SCENE_COOLDOWN_MS - 1), null);
    assert.notEqual(bubbles.say('click', SCENE_COOLDOWN_MS - 1), null, 'another scene is independent');
    assert.notEqual(bubbles.say('working', SCENE_COOLDOWN_MS), null);
    assert.notEqual(bubbles.say('working', SCENE_COOLDOWN_MS + 1, { force: true }), null);
  });

  it('rotates a long scene every eight seconds while it stays active', () => {
    const bubbles = controller();
    const first = bubbles.enterScene('working', 0);
    assert.equal(first.scene, 'working');

    const quiet = bubbles.tick(7_999);
    assert.equal(quiet.spoken, null, 'no rotation before 8 s');
    assert.equal(quiet.expired, true, 'the previous bubble expired first');

    const rotated = bubbles.tick(8_000);
    assert.equal(rotated.spoken?.scene, 'working');
    assert.notEqual(rotated.spoken?.text, first.text, 'next line from the pool');
    assert.equal(rotated.expired, false, 'the previous bubble was already gone');

    assert.equal(bubbles.enterScene('working', 9_000), null, 'same scene does not re-enter');
  });

  it('whispers only while idle, on its 45-90 s schedule, and obeys the switch', () => {
    const bubbles = controller();
    bubbles.enterScene('idle', 0);
    assert.equal(bubbles.chatter(CHATTER_RANGE_MS[0] - 1), null);
    const whispered = bubbles.chatter(CHATTER_RANGE_MS[0]);
    assert.equal(whispered.kind, 'chatter');
    assert.equal(whispered.scene, 'chatter');
    assert.equal(whispered.text, VOICE.zh.chatter[0]);

    assert.equal(bubbles.chatter(CHATTER_RANGE_MS[0] + 1000), null, 'next slot is later');
    bubbles.setChatterEnabled(false);
    assert.equal(bubbles.chatter(CHATTER_RANGE_MS[0] * 3), null);

    const busy = controller();
    busy.enterScene('working', 0);
    assert.equal(busy.chatter(CHATTER_RANGE_MS[0]), null, 'no chatter while working');
  });

  it('sleeps silently and only talks in dreams every 60-120 s', () => {
    const bubbles = controller();
    bubbles.enterScene('sleep', 0);
    assert.equal(bubbles.isAsleep(), true);
    assert.equal(bubbles.say('working', 1000), null, 'status bubbles stay quiet while asleep');
    assert.equal(bubbles.chatter(DREAM_RANGE_MS[0]), null, 'no chatter while asleep');

    assert.equal(bubbles.dream(DREAM_RANGE_MS[0] - 1), null);
    const dream = bubbles.dream(DREAM_RANGE_MS[0]);
    assert.equal(dream.kind, 'dream');
    assert.equal(dream.scene, 'sleep');
    assert.equal(dream.text, VOICE.zh.sleep[0]);
    assert.equal(bubbles.enterScene('idle', 70_000), null, 'waking does not speak by itself');
    assert.equal(bubbles.isAsleep(), false);
  });

  it('picks the voice of the active locale and accepts a replacement voice', () => {
    const zh = controller();
    const zhBubble = zh.say('greet', 0, { force: true });
    assert.equal(zhBubble.text, VOICE.zh.greet[0]);

    const en = createBubbleController({ voice: voiceForLocale(VOICE, 'en-US'), random: () => 0 });
    assert.equal(en.say('greet', 0, { force: true }).text, VOICE.en.greet[0]);

    en.setVoice({ greet: ['custom'] });
    assert.equal(en.say('greet', 1000, { force: true }).text, 'custom');
    assert.equal(en.say('idle', 2000, { force: true }), null, 'empty pool speaks nothing');
  });
});
