/**
 * DSH Workspace helpers shared by the goal form and the plan summary: display
 * names, live resolution, and the honest state for a workspace that no longer
 * exists in the registry.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveWorkspaceLinks, workspaceName } from '../../client/lib/workspaces.js';

const MATH = { workspaceId: 'ws_math', title: 'Math workspace', path: 'D:/study/math' };
const ENGLISH = { workspaceId: 'ws_english', title: '', path: 'D:/study/english' };

describe('workspaceName', () => {
  it('prefers the title, then the path, then the opaque id', () => {
    assert.equal(workspaceName(MATH), 'Math workspace');
    assert.equal(workspaceName(ENGLISH), 'D:/study/english');
    assert.equal(workspaceName({ workspaceId: 'ws_empty' }), 'ws_empty');
    assert.equal(workspaceName(null), '');
  });
});

describe('resolveWorkspaceLinks', () => {
  it('resolves ids in stored order and marks a deleted workspace', () => {
    const links = resolveWorkspaceLinks(['ws_english', 'ws_gone', 'ws_math'], [MATH, ENGLISH]);
    assert.deepEqual(links, [
      { workspaceId: 'ws_english', title: 'D:/study/english', path: 'D:/study/english', missing: false },
      { workspaceId: 'ws_gone', title: null, path: null, missing: true },
      { workspaceId: 'ws_math', title: 'Math workspace', path: 'D:/study/math', missing: false },
    ]);
  });

  it('drops malformed or empty ids instead of rendering blank rows', () => {
    assert.deepEqual(resolveWorkspaceLinks(['', 3, null, 'ws_math'], [MATH]).map(link => link.workspaceId), ['ws_math']);
    assert.deepEqual(resolveWorkspaceLinks(undefined, [MATH]), []);
    assert.deepEqual(resolveWorkspaceLinks(['ws_math'], undefined)[0].missing, true);
  });
});
