/**
 * Localized UI copy for the StudyBuddy pet plugin.
 *
 * Pet dialogue is not here: it lives in the replaceable voice packs
 * (`lines.js` / `voice-pack.js`). This dictionary owns only chrome — the
 * settings row, the pet button's accessible name, and the hover panel.
 */
import { NS } from './lines.js';

export { NS };

/** UI copy, keyed by locale. */
export const DICTIONARY = Object.freeze({
  en: Object.freeze({
    'pet.setting.label': 'StudyBuddy buddy',
    'pet.setting.description': 'A little buddy beside your session. It blinks, keeps you company while a turn runs, whispers to itself when idle, and dozes off if left alone.',
    'pet.setting.visible': 'Buddy',
    'pet.setting.shown': 'On',
    'pet.setting.hidden': 'Off',
    'pet.setting.chatter': 'Chatter',
    'pet.setting.chatterOn': 'On',
    'pet.setting.chatterOff': 'Off',
    'pet.setting.size': 'Size',
    'pet.setting.size.0.85': 'Small',
    'pet.setting.size.1': 'Regular',
    'pet.setting.size.1.2': 'Large',
    'pet.setting.hint': 'Drag the buddy to move it; the position is remembered.',
    'pet.alt': 'StudyBuddy buddy',
    'pet.action.hide': 'Hide',
    'pet.action.pat': 'Pat',
    'pet.action.chatter': 'Whisper',
    'pet.action.summon': 'Call the buddy back',
    'pet.panel.label': 'Buddy actions',
    'pet.bubble.label': 'Buddy says',
  }),
  zh: Object.freeze({
    'pet.setting.label': '小搭宠物',
    'pet.setting.description': '会话旁边的小搭：忙碌时陪着你，空闲时小声碎碎念，没人理就打个盹。',
    'pet.setting.visible': '小搭',
    'pet.setting.shown': '显示中',
    'pet.setting.hidden': '已隐藏',
    'pet.setting.chatter': '碎碎念',
    'pet.setting.chatterOn': '开',
    'pet.setting.chatterOff': '关',
    'pet.setting.size': '大小',
    'pet.setting.size.0.85': '小',
    'pet.setting.size.1': '标准',
    'pet.setting.size.1.2': '大',
    'pet.setting.hint': '拖动小搭可以换位置，位置会记住。',
    'pet.alt': '小搭宠物',
    'pet.action.hide': '隐藏',
    'pet.action.pat': '摸摸头',
    'pet.action.chatter': '碎碎念一句',
    'pet.action.summon': '叫小搭出来',
    'pet.panel.label': '小搭的小面板',
    'pet.bubble.label': '小搭说',
  }),
});
