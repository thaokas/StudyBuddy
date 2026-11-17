/**
 * Built-in voice lines for the StudyBuddy pet "小搭" (Xiaoda).
 *
 * This module is the language surface the research report calls "语言功能":
 * status bubbles, click/pet replies, periodic chatter, and sleep talk, all in
 * zh/en and replaceable by one JSON voice pack (see `voice-pack.js`).
 *
 * Every scene is one pool. The zh and en objects carry the exact same scene
 * keys, and each pool holds 4-8 short lines. Lines are plain text: no markup,
 * no placeholders, and no locale switching at runtime beyond picking the pool
 * for the active locale.
 */

/** Locale namespace owned by this plugin (settings row, pet labels). */
export const NS = 'study-pet';

/** Scenes a status bubble can present. */
export const STATUS_SCENES = Object.freeze([
  'idle', 'think', 'working', 'done', 'error', 'rest', 'greet', 'timerStart', 'timerFinish',
]);

/** Scenes triggered by a direct gesture. */
export const GESTURE_SCENES = Object.freeze(['click', 'pat']);

/** Scenes that are not tied to a session state. */
export const FREEFORM_SCENES = Object.freeze(['chatter', 'sleep']);

/** Every scene key the built-in voice packs must define. */
export const SCENES = Object.freeze([...STATUS_SCENES, ...GESTURE_SCENES, ...FREEFORM_SCENES]);

/** Built-in voice packs. */
export const VOICE = Object.freeze({
  zh: Object.freeze({
    idle: Object.freeze([
      '我在这儿，慢慢来。',
      '需要我陪你一会儿吗？',
      '窗边的光刚好，适合看书。',
      '不急，一页一页读。',
      '我帮你看着时间。',
    ]),
    think: Object.freeze([
      '嗯……让我想想。',
      '这个思路好像有光。',
      '先把问题拆小一点。',
      '我在旁边一起想。',
      '等你想清楚，我再接着走。',
    ]),
    working: Object.freeze([
      '正在专注，请稍等。',
      '笔尖沙沙的，很好听。',
      '这一段快写完了。',
      '我陪你把这页做完。',
      '专注中，碎碎念先收起来。',
      '快了，再坚持一下下。',
    ]),
    done: Object.freeze([
      '做完啦，合上这一页。',
      '这一步完成了，伸个懒腰吧。',
      '收工，给你留一颗小星星。',
      '又往前挪了一点。',
      '我记下了，今天有进展。',
    ]),
    error: Object.freeze([
      '呀，这里卡住了。',
      '没关系，出错也是线索。',
      '我先擦擦汗，我们重来。',
      '这一步没走通，换个办法。',
      '我在，别急。',
    ]),
    rest: Object.freeze([
      '休息一下吧，眼睛也要放假。',
      '喝口水，回来再继续。',
      '我打个盹，你也歇会儿。',
      '松一松肩膀，很值得。',
    ]),
    sleep: Object.freeze([
      '梦里也在翻书……',
      '梨子味的云，软软的。',
      '别叫醒我，我在背单词。',
      '书签掉在第七页了……',
      '呼……再睡一小会儿。',
      '梦到一棵会发光的树。',
    ]),
    click: Object.freeze([
      '叫我吗？我在。',
      '戳一下，长一点力气。',
      '嘿，今天想学什么？',
      '我听见啦。',
      '要一起把这一页看完吗？',
      '轻一点，叶子会痒。',
    ]),
    pat: Object.freeze([
      '唔，头顶暖暖的。',
      '叶子被你摸得翘起来了。',
      '再摸一下也不是不可以。',
      '谢谢你，我今天很有精神。',
      '摸摸头收到。',
    ]),
    chatter: Object.freeze([
      '今天的风把纸吹得一角翘起来。',
      '我数了数，杯子里还有三口茶。',
      '笔记边上的小涂鸦长叶子了。',
      '要是累了，先把书合上也没关系。',
      '刚才那句话，你读了两遍呢。',
      '窗外的云像一块没写完的橡皮。',
      '我把书签往右挪了一点点。',
    ]),
    timerStart: Object.freeze([
      '专注时间开始，我守着你。',
      '这一小段，只做眼前这件事。',
      '计时开始，手机先放远一点。',
      '我在这里，陪你到铃响。',
    ]),
    timerFinish: Object.freeze([
      '叮，时间到，辛苦了。',
      '这一段专注收下了。',
      '站起来走两步吧。',
      '计时结束，给自己一点掌声。',
    ]),
    greet: Object.freeze([
      '我来啦，今天也一起。',
      '醒醒，我在呢。',
      '早上好，今天从哪一页开始？',
      '又见面了，书还翻在上次那页。',
    ]),
  }),
  en: Object.freeze({
    idle: Object.freeze([
      "I'm right here. Take your time.",
      'Want some quiet company?',
      'The light is nice for reading.',
      'No rush — one page at a time.',
      "I'll keep an eye on the time.",
    ]),
    think: Object.freeze([
      'Hmm… let me think.',
      'That idea has a little shine to it.',
      'Let us make the question smaller.',
      'Thinking right beside you.',
      "I'll follow once it is clear.",
    ]),
    working: Object.freeze([
      'Focused right now — one moment.',
      'The pencil sounds nice on paper.',
      'Almost through this paragraph.',
      "Let's finish this page together.",
      'Focus mode: chatter is on hold.',
      'Almost there. One more push.',
    ]),
    done: Object.freeze([
      'Done — closing this page.',
      'Step complete. Time to stretch.',
      'All wrapped up. A little star for you.',
      'A little further than before.',
      'Noted. Today moved forward.',
    ]),
    error: Object.freeze([
      'Oh — this part got stuck.',
      'It is okay. Mistakes are clues.',
      'Let me wipe the sweat. Again from here.',
      'That path did not work. Another one?',
      "I'm here. No hurry.",
    ]),
    rest: Object.freeze([
      'Take a break — eyes need one too.',
      'Some water, then back to it.',
      'I will doze a bit. You rest too.',
      'Unclench those shoulders. Worth it.',
    ]),
    sleep: Object.freeze([
      'Still turning pages in my dream…',
      'Pear-scented clouds. Very soft.',
      "Don't wake me — I'm reciting words.",
      'My bookmark fell out at page seven…',
      'Mmm… five more minutes.',
      'Dreamed of a tree full of light.',
    ]),
    click: Object.freeze([
      'You called? I am here.',
      'One poke, one little boost.',
      'Hey. What shall we learn today?',
      'I heard that.',
      'Shall we finish this page together?',
      'Gently — my leaves tickle.',
    ]),
    pat: Object.freeze([
      'Mmm. Warm on top.',
      'You made my leaf stand up.',
      'One more pat would be fine too.',
      'Thank you. I feel bright today.',
      'Head pat received.',
    ]),
    chatter: Object.freeze([
      'The wind turned up one corner of the page.',
      'I counted three sips of tea left in the cup.',
      'The doodle in the margin grew a leaf.',
      'If you are tired, closing the book is fine.',
      'You read that sentence twice, you know.',
      'The cloud outside looks like an unwritten eraser.',
      'I nudged the bookmark a little to the right.',
    ]),
    timerStart: Object.freeze([
      'Focus time starts. I have you.',
      'Just this one small stretch.',
      'Timer running — put the phone away.',
      'I stay here until the bell.',
    ]),
    timerFinish: Object.freeze([
      'Ding. Time is up — good work.',
      'That stretch of focus is counted.',
      'Stand up and walk a little.',
      'Timer done. Give yourself a clap.',
    ]),
    greet: Object.freeze([
      "I'm here. Let's go together today.",
      "I'm awake, right here.",
      'Morning. Which page do we start on?',
      'Hello again. The book is still open.',
    ]),
  }),
});

/**
 * Collapse a BCP 47-style active locale to a built-in voice locale.
 * @param {string | undefined} active - Active locale from `ctx.locale`.
 * @returns {'zh' | 'en'} Voice locale; everything except Chinese reads English.
 */
export function voiceLocale(active) {
  return typeof active === 'string' && active.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * Read one scene pool of one voice locale.
 * @param {'zh' | 'en'} locale - Voice locale.
 * @param {string} scene - Scene key.
 * @returns {readonly string[]} Lines of that pool, or an empty list for an unknown scene.
 */
export function linesFor(locale, scene) {
  const pack = VOICE[locale] ?? VOICE.en;
  return pack[scene] ?? [];
}
