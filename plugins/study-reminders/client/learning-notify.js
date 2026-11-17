/** Renderer-only learning notifications. The reminder key is also the OS tag. */
export function createLearningNotifier({ env = globalThis, storage = env.localStorage } = {}) {
  const storageKey = 'study.learning.notified.v1';
  let seen = new Set();
  try { seen = new Set(JSON.parse(storage?.getItem(storageKey) ?? '[]')); } catch {}
  function remember(key) {
    seen.add(key);
    try { storage?.setItem(storageKey, JSON.stringify([...seen].slice(-500))); } catch {}
  }
  function notify(key, title, body) {
    // Only a delivered notification consumes its key. A denied or unsupported
    // notice leaves the key free so granting permission later still shows the
    // still-pending reminder once, without a second in-app announcement.
    if (seen.has(key)) return false;
    try {
      if (env.Notification?.permission !== 'granted') return false;
      new env.Notification(title, { body, tag: key });
    } catch { return false; }
    remember(key);
    return true;
  }
  return {
    notify,
    permission: () => {
      try { return env.Notification?.permission ?? 'unsupported'; } catch { return 'unsupported'; }
    },
    requestPermission: async () => {
      try { return await env.Notification?.requestPermission?.() ?? 'unsupported'; } catch { return 'denied'; }
    },
    reminders: items => items.forEach(item => {
      if (['shown','snoozed'].includes(item.state)) notify(item.key, item.title, `${item.start}–${item.end}`);
    }),
    timer: session => {
      if (session?.phase === 'finished' && session.outcome === 'completed') {
        notify(`timer:${session.id}`, 'StudyBuddy', 'Pomodoro finished');
      }
    },
  };
}
