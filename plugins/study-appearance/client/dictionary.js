/**
 * Client dictionary for the appearance plugin. One plugin owns one locale
 * namespace; the settings row and any future surface read keys from here.
 * Copy follows the appearance design spec §6 (sentence case in English).
 */
export const NS = 'study-appearance';

export const DICTIONARY = Object.freeze({
  en: Object.freeze({
    'appearance.setting.label': 'StudyBuddy appearance',
    'appearance.setting.description': 'Pick one light and one dark palette. Each pack colors the sidebar, canvas and top bar together, with a readable green or blue accent.',
    'appearance.setting.enabled': 'On',
    'appearance.setting.disabled': 'Off',
    'appearance.light.label': 'Light palette',
    'appearance.dark.label': 'Dark palette',
    'appearance.pack.sprout-paper': 'Sprout Paper',
    'appearance.pack.mint-mist': 'Mint Mist',
    'appearance.pack.celadon-page': 'Celadon Page',
    'appearance.pack.deep-sea': 'Deep Sea',
    'appearance.pack.midnight-indigo': 'Midnight Indigo',
    'appearance.pack.starry-blue': 'Starry Blue',
    'appearance.preview.alt': 'Buddy preview',
    'appearance.brand.alt': 'StudyBuddy buddy',
    'appearance.hint.native': 'Menus, native controls, and overlays stay native.',
    'appearance.hint.a11y': 'Motion and transparency follow your system preferences.',
    'appearance.restore': 'Turns off immediately and restores the native DSH look.',
    'appearance.error': 'Appearance failed to load; the native UI is unchanged.',
  }),
  zh: Object.freeze({
    'appearance.setting.label': 'StudyBuddy 外观',
    'appearance.setting.description': '浅色组与深色组各选一套；每套同时决定侧边栏、画布与顶栏，主色使用可读的绿色或蓝色。',
    'appearance.setting.enabled': '已开启',
    'appearance.setting.disabled': '已关闭',
    'appearance.light.label': '浅色组',
    'appearance.dark.label': '深色组',
    'appearance.pack.sprout-paper': '嫩芽纸本',
    'appearance.pack.mint-mist': '薄荷晨雾',
    'appearance.pack.celadon-page': '青瓷书页',
    'appearance.pack.deep-sea': '深海夜航',
    'appearance.pack.midnight-indigo': '午夜靛蓝',
    'appearance.pack.starry-blue': '星海雾蓝',
    'appearance.preview.alt': '梨伴形象预览',
    'appearance.brand.alt': 'StudyBuddy 梨伴',
    'appearance.hint.native': '菜单、原生控件与弹层保持 DSH 原样。',
    'appearance.hint.a11y': '动效与透明会跟随系统偏好自动减少。',
    'appearance.restore': '关闭后立即恢复 DSH 原生外观，无需重启。',
    'appearance.error': '外观加载失败，已保持原生界面。',
  }),
});
