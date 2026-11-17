/**
 * Copy for reply-completion reminders. The client entry merges this module into
 * the `study` namespace, so the overlay banner and the settings row read the
 * same dictionary as the pages.
 */
export default {
  en: {
    'notify.banner.single': '{title} finished replying',
    'notify.banner.merged': '{count} sessions finished replying',
    'notify.banner.fallback': 'System notifications are unavailable; this in-app notice still works.',
    'notify.banner.open': 'Open',
    'notify.banner.dismiss': 'Got it',
    'notify.banner.disable': 'Turn off these reminders',
    'notify.notification.title': 'StudyBuddy',
    'notify.setting.label': 'Notify when a reply finishes',
    'notify.setting.description': 'One reminder when a reply finishes while you are in another view. A closed app sends nothing.',
    'notify.setting.on': 'On',
    'notify.setting.off': 'Off',
    'notify.setting.osReady': 'System notifications are on.',
    'notify.setting.osBlocked': 'System notifications are blocked; only the in-app notice appears.',
    'notify.setting.osUnavailable': 'System notifications are unavailable; only the in-app notice appears.',
  },
  zh: {
    'notify.banner.single': '「{title}」回复完成',
    'notify.banner.merged': '{count} 个会话的回复完成',
    'notify.banner.fallback': '系统通知不可用，应用内提示仍然有效。',
    'notify.banner.open': '查看',
    'notify.banner.dismiss': '知道了',
    'notify.banner.disable': '关闭这类提醒',
    'notify.notification.title': 'StudyBuddy',
    'notify.setting.label': '回复完成时提醒',
    'notify.setting.description': '在别的界面时，助手回复结束提醒一次；应用关闭不提醒。',
    'notify.setting.on': '已开启',
    'notify.setting.off': '已关闭',
    'notify.setting.osReady': '系统通知已开启。',
    'notify.setting.osBlocked': '系统通知被拒绝，只显示应用内提示。',
    'notify.setting.osUnavailable': '系统通知不可用，只显示应用内提示。',
  },
};
