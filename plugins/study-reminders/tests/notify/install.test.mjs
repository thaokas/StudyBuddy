/**
 * Plugin wiring: the reminder contributes exactly two additive entries (the
 * shell overlay banner and the General settings row), forwards live state
 * through the injected `hooks` compartment, and removes everything with the
 * plugin fiber.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../../../study-outcomes/tests/client/support/react-stub.mjs';
import { DICTIONARY, clock, gateway, listOf, memoryArea, sessionList } from './support.mjs';

installReactStub();

const {
  BANNER_ID, BANNER_SLOT, CompletionBanner, NotifyToggle, SETTINGS_ID, SETTINGS_SLOT,
  createBrowserGateway, installCompletionNotify,
} = await import('../../client/notify.js');

/**
 * Cordis client context stand-in with the pieces the installer reads.
 * `inject` mirrors the real in-place form: the callback runs once every named
 * service is registered, which is how the plugin reaches `sessions`.
 * @param {{ sessions?: object, uiWorkspace?: object, withGet?: boolean, withInject?: boolean }} [options]
 *   Service overrides.
 * @returns {{ ctx: object, state: object }} Fake context and its ledger.
 */
function createCtx({ sessions, uiWorkspace, withGet = true, withInject = true } = {}) {
  const state = {
    entries: [],
    slotNames: [],
    injections: [],
    effects: [],
    dictionaries: new Map(),
    services: new Map(),
  };
  const ctx = {
    locale: {
      register(namespace, dictionary) {
        state.dictionaries.set(namespace, dictionary);
        return () => { state.dictionaries.delete(namespace); };
      },
      bind(namespace) {
        return (key, params) => {
          const dictionary = state.dictionaries.get(namespace);
          const template = dictionary?.en?.[key] ?? key;
          if (params === undefined) return template;
          return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
        };
      },
    },
    effect(run) {
      const dispose = run();
      state.effects.push(dispose);
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    slots: {
      inject(name, callback) {
        state.slotNames.push(name);
        const dispose = callback();
        return () => { if (typeof dispose === 'function') dispose(); };
      },
      register(options, component) {
        const entry = { options, component };
        state.entries.push(entry);
        return () => {
          const index = state.entries.indexOf(entry);
          if (index >= 0) state.entries.splice(index, 1);
        };
      },
    },
  };
  if (withGet) {
    if (uiWorkspace !== undefined) state.services.set('uiWorkspace', uiWorkspace);
    ctx.get = name => state.services.get(name);
  }
  if (withInject) {
    ctx.inject = (names, callback) => {
      state.injections.push(names);
      if (!names.every(name => state.services.has(name))) return () => {};
      const scope = { ...ctx, sessions: state.services.get('sessions') };
      callback(scope);
      return () => {};
    };
  }
  if (sessions !== undefined) state.services.set('sessions', sessions);
  // The plugin body registers the merged dictionary before the installer runs.
  ctx.locale.register('study', DICTIONARY);
  return { ctx, state };
}

/**
 * Installer options over the virtual clock and recording gateway.
 * @param {{ time?: object, permissions?: object }} [options] - Edge overrides.
 * @returns {object} Installer options plus the recording edges.
 */
function options({ time = clock(), permissions = gateway() } = {}) {
  return {
    namespace: 'study',
    gateway: permissions,
    storage: { local: memoryArea(), session: memoryArea() },
    timer: time.timer,
    now: time.now,
  };
}

describe('installCompletionNotify', () => {
  it('registers the banner and the settings row next to the study entries', () => {
    const sessions = sessionList(listOf([]));
    const { ctx, state } = createCtx({ sessions });
    installCompletionNotify(ctx, options());

    assert.deepEqual(state.slotNames, [BANNER_SLOT, SETTINGS_SLOT]);
    const banner = state.entries.find(entry => entry.options.name === BANNER_SLOT);
    const settings = state.entries.find(entry => entry.options.name === SETTINGS_SLOT);
    assert.equal(banner.options.id, BANNER_ID);
    assert.equal(settings.options.id, SETTINGS_ID);
    assert.equal(banner.options.locale, 'study');
    assert.equal(settings.options.locale, 'study');
    assert.equal(typeof settings.options.order, 'number');
    assert.equal(banner.component, CompletionBanner);
    assert.equal(settings.component, NotifyToggle);
  });

  it('hands both entries one live completion source', () => {
    const sessions = sessionList(listOf([]));
    const { ctx, state } = createCtx({ sessions });
    installCompletionNotify(ctx, options());

    const faces = state.entries.map(entry => entry.options.inject());
    const banner = faces.find(face => typeof face.dismiss === 'function');
    const settings = faces.find(face => typeof face.setEnabled === 'function' && face.dismiss === undefined);
    assert.equal(typeof banner.hooks.completion.getSnapshot, 'function');
    assert.equal(typeof banner.hooks.completion.subscribe, 'function');
    assert.equal(settings.hooks.completion, banner.hooks.completion, '两个入口必须读同一个源');
    assert.equal(typeof banner.focus, 'function');
  });

  it('announces a completion observed through the wired subscription', () => {
    const sessions = sessionList(listOf([{ id: 's1', running: true, updatedAt: 10 }]));
    const permissions = gateway({ permission: 'granted' });
    const time = clock();
    const { ctx, state } = createCtx({ sessions });
    installCompletionNotify(ctx, options({ permissions, time }));

    const face = state.entries[0].options.inject();
    assert.equal(face.hooks.completion.getSnapshot().entries.length, 0);

    sessions.set(listOf([{ id: 's1', running: false, updatedAt: 10 }]));
    time.advance(5000);

    assert.equal(face.hooks.completion.getSnapshot().entries.length, 1);
    assert.equal(permissions.shown.length, 1);
  });

  it('opens the finished session through the workspace navigation', () => {
    const sessions = sessionList(listOf([{ id: 's1', running: true, updatedAt: 10 }]));
    const opened = [];
    const time = clock();
    const { ctx, state } = createCtx({ sessions, uiWorkspace: { openSession: id => opened.push(id) } });
    const notifier = installCompletionNotify(ctx, options({ time }));

    const face = state.entries[0].options.inject();
    sessions.set(listOf([{ id: 's1', running: false, updatedAt: 10 }]));
    time.advance(5000);
    face.focus('s1');

    assert.deepEqual(opened, ['s1']);
    assert.equal(face.hooks.completion.getSnapshot().focusable, true);
    assert.equal(notifier.source.getSnapshot().entries.length, 0);
  });

  it('reports no navigation capability without the workspace service', () => {
    const sessions = sessionList(listOf([]));
    const { ctx, state } = createCtx({ sessions });
    installCompletionNotify(ctx, options());
    const face = state.entries[0].options.inject();
    assert.equal(face.hooks.completion.getSnapshot().focusable, false);
  });

  it('drops the session subscription with the plugin fiber', () => {
    const sessions = sessionList(listOf([{ id: 's1', running: true }]));
    const { ctx, state } = createCtx({ sessions });
    installCompletionNotify(ctx, options());
    assert.equal(sessions.listenerCount(), 1);

    for (const dispose of state.effects) {
      if (typeof dispose === 'function') dispose();
    }
    assert.equal(sessions.listenerCount(), 0);
  });

  it('waits for the Session service instead of declaring it required', () => {
    const sessions = sessionList(listOf([]));
    const { ctx, state } = createCtx({ sessions });
    installCompletionNotify(ctx, options());
    assert.deepEqual(state.injections, [['sessions']]);
  });

  it('stays inert when the client has no Session service', () => {
    const { ctx, state } = createCtx({});
    assert.doesNotThrow(() => installCompletionNotify(ctx, options()));
    assert.deepEqual(state.entries, []);
    assert.deepEqual(state.slotNames, []);
  });

  it('stays inert on a context without in-place injection', () => {
    const sessions = sessionList(listOf([]));
    const { ctx, state } = createCtx({ sessions, withInject: false });
    assert.doesNotThrow(() => installCompletionNotify(ctx, options()));
    assert.deepEqual(state.entries, []);
  });

  it('stays inert on a context without the service reader', () => {
    const { ctx, state } = createCtx({ withGet: false });
    assert.doesNotThrow(() => installCompletionNotify(ctx, options()));
    assert.deepEqual(state.entries, []);
  });
});

describe('createBrowserGateway', () => {
  it('degrades to unsupported without a Notification constructor', () => {
    const browser = createBrowserGateway({});
    assert.equal(browser.supported, false);
    assert.equal(browser.permission, 'unsupported');
    assert.equal(browser.show({ title: 'x', body: 'y' }), undefined);
  });

  it('asks the constructor for permission and shows once granted', async () => {
    const shown = [];
    class FakeNotice {
      static permission = 'default';
      static async requestPermission() {
        FakeNotice.permission = 'granted';
        return 'granted';
      }
      constructor(title, options) {
        shown.push({ title, options });
        this.onclick = null;
        this.closed = false;
      }
      close() { this.closed = true; }
    }
    const browser = createBrowserGateway({ Notification: FakeNotice });
    assert.equal(browser.supported, true);
    assert.equal(await browser.requestPermission(), 'granted');
    assert.equal(browser.permission, 'granted');

    let clicked = 0;
    const notice = browser.show({ title: 'StudyBuddy', body: 'reply finished', tag: 'study.completion', onClick: () => { clicked += 1; } });
    assert.equal(shown.length, 1);
    assert.equal(shown[0].options.tag, 'study.completion');
    notice.onclick();
    assert.equal(clicked, 1);
    assert.equal(notice.closed, true);
  });

  it('contains a refused notification instead of breaking the banner', () => {
    class Refusing {
      static permission = 'granted';
      constructor() { throw new Error('refused'); }
    }
    const browser = createBrowserGateway({ Notification: Refusing });
    assert.equal(browser.show({ title: 'x', body: 'y' }), undefined);
  });
});
