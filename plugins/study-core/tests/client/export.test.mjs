import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installReactStub } from '../../../study-outcomes/tests/client/support/react-stub.mjs';
installReactStub();
const { createPlugin } = await import('../../client/plugin.js');
const page = (await import('../../client/pages/today.js')).default;
const dictionary = (await import('../../client/messages/today.js')).default;

test('core exposes export options in general settings without adding a sidebar page', () => {
  const entries = [];
  const services = {};
  const ctx = {
    effect: run => run(), provide: (key, value) => { services[key] = value; },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (_key, run) => run(), register: (options, Component) => { entries.push({ options, Component }); return () => {}; }, entries: () => [], subscribe: () => () => {} },
    get: name => services[name], inject: () => {},
  };
  createPlugin({ pages: [{ file: 'today', definition: page }], messages: [{ file: 'today', dictionary }], actions: [] }).apply(ctx);
  assert.equal(entries.filter(x => x.options.name === 'sidebar.panellist').length, 1);
  const row = entries.find(x => x.options.name === 'settings.general.item' && x.options.id === 'study.export');
  assert.ok(row, 'export must be discoverable from General settings');
  assert.equal(typeof row.Component, 'function');
});

test('export settings submit selected periods and facts, show the local receipt and surface failure reasons', async () => {
  const { ExportSettingsView, requestStudyExport } = await import('../../client/export.js');
  const create = (type, props, ...children) => ({ type, props, children });
  const text = node => node === null || node === undefined ? '' : typeof node === 'object' ? (Array.isArray(node) ? node.map(text).join('') : text(node.children)) : String(node);
  const options = { periods: ['month'], includeFacts: false };
  const value = await requestStudyExport(options, async (url, request) => {
    assert.equal(url, 'api/study/export.json');
    assert.deepEqual(JSON.parse(request.body), options);
    return { json: async () => ({ ok: true, value: { path: 'study/exports/export.json', bytes: 123, revision: 7 } }) };
  });
  const props = { create, t: key => key, period: 'month', includeFacts: false, onPeriod() {}, onFacts() {}, onExport() {} };
  assert.match(text(ExportSettingsView({ ...props, view: { phase: 'ready', value } })), /study\/exports\/export.json.*123 B.*7/);
  assert.match(text(ExportSettingsView({ ...props, view: { phase: 'error', message: '磁盘不可写' } })), /磁盘不可写/);
  await assert.rejects(requestStudyExport(options, async () => ({ json: async () => ({ ok: false, message: '凭据内容禁止导出' }) })), /凭据内容禁止导出/);
});
