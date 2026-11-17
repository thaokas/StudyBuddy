import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VOICE } from '../client/lines.js';
import {
  MAX_LINE_LENGTH,
  MAX_POOL_LINES,
  VOICE_KEY,
  mergeVoicePack,
  parseVoicePack,
  readVoicePack,
} from '../client/voice-pack.js';

const VALID_PACK = {
  status: {
    idle: ['自定义闲置一', '自定义闲置二', '自定义闲置三', '自定义闲置四'],
    done: ['做完了'],
  },
  click: ['点我一下'],
  chatter: ['碎碎念替换'],
  sleep: ['梦话替换'],
};

/** @returns {{ getItem: Function, setItem: Function, removeItem: Function }} Fake storage. */
function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
  };
}

describe('pet voice pack', () => {
  it('accepts an absent or empty pack', () => {
    assert.deepEqual(parseVoicePack(undefined), { ok: true, pack: null });
    assert.deepEqual(parseVoicePack(null), { ok: true, pack: null });
    assert.deepEqual(parseVoicePack('   '), { ok: true, pack: null });
  });

  it('normalizes a valid pack and freezes its pools', () => {
    const result = parseVoicePack(JSON.stringify(VALID_PACK));
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.pack.status).sort(), ['done', 'idle']);
    assert.equal(result.pack.click[0], '点我一下');
    assert.equal(Object.isFrozen(result.pack.status.idle), true);
    assert.equal(Object.isFrozen(result.pack), true);
    assert.deepEqual(Object.keys(result.pack).sort(), ['chatter', 'click', 'sleep', 'status']);
  });

  it('merges overrides into both locales without mutating the built-in voice', () => {
    const { pack } = parseVoicePack(VALID_PACK);
    const merged = mergeVoicePack(VOICE, pack);
    for (const locale of ['zh', 'en']) {
      assert.deepEqual(merged[locale].idle, VALID_PACK.status.idle, `${locale} idle is replaced`);
      assert.deepEqual(merged[locale].done, VALID_PACK.status.done, `${locale} done is replaced`);
      assert.deepEqual(merged[locale].click, VALID_PACK.click, `${locale} click is replaced`);
      assert.equal(merged[locale].think, VOICE[locale].think, `${locale} think keeps builtin`);
      assert.equal(merged[locale].pat, VOICE[locale].pat, `${locale} pat keeps builtin`);
    }
    assert.notEqual(merged.zh.idle, VOICE.zh.idle);
    assert.equal(VOICE.zh.click.length, 6, 'built-in voice is untouched');
    assert.notEqual(merged, VOICE);
  });

  it('keeps built-in lines for omitted keys and empty pools', () => {
    const partial = parseVoicePack({ click: [] });
    assert.equal(partial.ok, true);
    const merged = mergeVoicePack(VOICE, partial.pack);
    assert.equal(merged.zh.click, VOICE.zh.click);
    assert.equal(merged.en.click, VOICE.en.click);
    assert.equal(mergeVoicePack(VOICE, null), VOICE);
  });

  it('rejects malformed packs as a whole', () => {
    const cases = [
      ['not json', 'not valid JSON'],
      ['[1,2]', 'root must be a JSON object'],
      ['null', 'root must be a JSON object'],
      ['{"unknown":[]}', 'unknown key'],
      ['{"status":{"nope":["a"]}}', 'unknown status scene'],
      ['{"status":[]}', 'status must be an object'],
      ['{"status":{"idle":"a"}}', 'must be an array'],
      ['{"click":[1]}', 'must be a string'],
      ['{"click":["  "]}', 'must not be empty'],
      ['{"click":["a\\nb"]}', 'single line'],
    ];
    for (const [raw, expected] of cases) {
      const result = parseVoicePack(raw);
      assert.equal(result.ok, false, `${raw} should be rejected`);
      assert.match(result.error, new RegExp(expected), `${raw} reason`);
      assert.match(result.warning, /voice pack ignored/);
    }
  });

  it('bounds pool length and line length', () => {
    const tooMany = parseVoicePack({ click: Array.from({ length: MAX_POOL_LINES + 1 }, (_, i) => `line ${i}`) });
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.error, /max 64/);

    const atLimit = parseVoicePack({ click: Array.from({ length: MAX_POOL_LINES }, (_, i) => `line ${i}`) });
    assert.equal(atLimit.ok, true);

    const tooLong = parseVoicePack({ chatter: ['x'.repeat(MAX_LINE_LENGTH + 1)] });
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.error, new RegExp(`max ${MAX_LINE_LENGTH}`));

    const atLength = parseVoicePack({ chatter: ['x'.repeat(MAX_LINE_LENGTH)] });
    assert.equal(atLength.ok, true);
  });

  it('reads a stored pack and warns on broken storage values', () => {
    const warnings = [];
    const store = fakeStorage({ [VOICE_KEY]: JSON.stringify(VALID_PACK) });
    const pack = readVoicePack(store, { warn: message => warnings.push(message) });
    assert.equal(pack.status.idle.length, 4);
    assert.deepEqual(warnings, []);

    assert.equal(readVoicePack(fakeStorage(), { warn: message => warnings.push(message) }), null);
    assert.deepEqual(warnings, []);

    const broken = readVoicePack(fakeStorage({ [VOICE_KEY]: '{oops' }), { warn: message => warnings.push(message) });
    assert.equal(broken, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /voice pack ignored/);

    const throwing = {
      getItem() {
        throw new Error('blocked');
      },
    };
    assert.equal(readVoicePack(throwing, { warn: message => warnings.push(message) }), null);
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /could not be read/);
    assert.equal(readVoicePack(null), null);
  });
});
