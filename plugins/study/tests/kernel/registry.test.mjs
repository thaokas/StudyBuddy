import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NAMESPACES, StudyError, createRegistry, isPlainObject } from '../../host/registry.mjs';

test('the namespace list is frozen to the service contract', () => {
  assert.deepEqual([...NAMESPACES], ['kernel', 'tasks', 'materials', 'plans', 'planning', 'tutoring', 'timer', 'followup', 'outcomes', 'milestones', 'memory', 'learning', 'review']);
  assert.throws(() => { NAMESPACES.push('extra'); }, TypeError);
});

test('isPlainObject accepts lossless JSON objects only', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(new Map()), false);
  assert.equal(isPlainObject('text'), false);
  assert.equal(isPlainObject(1), false);
});

test('a namespace implementation is validated before it is reachable', () => {
  const registry = createRegistry();
  const invalid = [
    ['unknown', { methods: { read: () => 1 } }],
    ['tasks', undefined],
    ['tasks', { methods: {} }],
    ['tasks', { methods: { Bad: () => 1 } }],
    ['tasks', { methods: { read: 1 } }],
    ['tasks', { methods: { read: () => 1 }, writes: ['missing'] }],
    ['tasks', { methods: { read: () => 1 }, writes: 'read' }],
  ];
  for (const [ns, impl] of invalid) {
    assert.throws(
      () => registry.register(ns, impl),
      error => error instanceof StudyError && error.code === 'invalid',
      `expected invalid registration for ${ns}`,
    );
  }
  assert.deepEqual(registry.list(), []);
});

test('resolve returns the declared handler and write flag', () => {
  const registry = createRegistry();
  const list = () => 'listed';
  registry.register('tasks', { methods: { list, create: () => 'made' }, writes: ['create'] });
  assert.equal(registry.resolve('tasks', 'list').handler, list);
  assert.equal(registry.resolve('tasks', 'list').isWrite, false);
  assert.equal(registry.resolve('tasks', 'create').isWrite, true);
  assert.deepEqual(registry.list(), [{ ns: 'tasks', methods: ['list', 'create'], writes: ['create'] }]);
});

test('an unknown namespace or method is not_found and duplicates are invalid', () => {
  const registry = createRegistry();
  registry.register('tasks', { methods: { list: () => 1 } });
  assert.throws(() => registry.resolve('plans', 'list'), error => error.code === 'not_found');
  assert.throws(() => registry.resolve('tasks', 'missing'), error => error.code === 'not_found');
  assert.throws(() => registry.register('tasks', { methods: { list: () => 1 } }), error => error.code === 'invalid');
});

test('the registration disposer unregisters once and removes the contribution', () => {
  const events = [];
  const registry = createRegistry({
    onRegister: ns => {
      events.push(`add:${ns}`);
      return () => events.push(`remove:${ns}`);
    },
  });
  const dispose = registry.register('timer', { methods: { read: () => 1 } });
  assert.deepEqual(events, ['add:timer']);
  assert.equal(registry.has('timer'), true);
  dispose();
  dispose();
  assert.deepEqual(events, ['add:timer', 'remove:timer']);
  assert.equal(registry.has('timer'), false);
});

test('a failing contribution leaves no namespace behind', () => {
  const registry = createRegistry({ onRegister: () => { throw new Error('route clash'); } });
  assert.throws(() => registry.register('timer', { methods: { read: () => 1 } }), /route clash/);
  assert.equal(registry.has('timer'), false);
});

test('StudyError rejects unknown codes and keeps details', () => {
  assert.throws(() => new StudyError('bogus', 'text'), TypeError);
  const error = new StudyError('conflict', 'message', { revision: 1 });
  assert.equal(error.code, 'conflict');
  assert.deepEqual(error.details, { revision: 1 });
  assert.equal(error.name, 'StudyError');
});
