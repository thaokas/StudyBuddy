/**
 * DSH workspace reads for the study surfaces.
 *
 * The Workspace registry belongs to the DSH client, not to the study database.
 * A goal stores only the workspace ids it is linked to; every surface resolves
 * those ids to the current title and path through the live Workspace snapshot,
 * so a rename immediately shows the new name and a deleted workspace is
 * reported as unavailable rather than silently disappearing.
 */
import { useSyncExternalStore } from 'react';

const NOOP_SUBSCRIBE = () => () => {};

/** Stable empty snapshot used when the client does not expose the Workspace service. */
const EMPTY_SNAPSHOT = Object.freeze({ items: [] });

/** @returns {{ items: [] }} Stable empty Workspace snapshot. */
function emptySnapshot() {
  return EMPTY_SNAPSHOT;
}

/**
 * Subscribe one component to the live DSH workspace items.
 * @param {{ getSnapshot?: Function, subscribe?: Function } | undefined} source - Workspace list source.
 * @returns {object[]} Workspace rows, or an empty list when the service is absent.
 */
export function useWorkspaceItems(source) {
  const snapshot = useSyncExternalStore(
    typeof source?.subscribe === 'function' ? source.subscribe : NOOP_SUBSCRIBE,
    typeof source?.getSnapshot === 'function' ? source.getSnapshot : emptySnapshot,
  );
  return Array.isArray(snapshot?.items) ? snapshot.items : [];
}

/**
 * Display name for one Workspace row.
 * @param {object | null | undefined} workspace - Workspace view.
 * @returns {string} Title, then path, then the opaque id.
 */
export function workspaceName(workspace) {
  const title = typeof workspace?.title === 'string' ? workspace.title.trim() : '';
  if (title !== '') return title;
  if (typeof workspace?.path === 'string' && workspace.path.trim() !== '') return workspace.path;
  return typeof workspace?.workspaceId === 'string' ? workspace.workspaceId : '';
}

/**
 * Resolve goal workspace ids against the current Workspace snapshot.
 * @param {unknown} workspaceIds - Ids stored on the goal.
 * @param {object[]} workspaces - Current Workspace rows.
 * @returns {Array<{ workspaceId: string, title: string | null, path: string | null, missing: boolean }>}
 *   One entry per id in stored order; `missing` means the registry no longer has it.
 */
export function resolveWorkspaceLinks(workspaceIds, workspaces) {
  const byId = new Map((Array.isArray(workspaces) ? workspaces : [])
    .filter(workspace => typeof workspace?.workspaceId === 'string')
    .map(workspace => [workspace.workspaceId, workspace]));
  return (Array.isArray(workspaceIds) ? workspaceIds : [])
    .filter(workspaceId => typeof workspaceId === 'string' && workspaceId.length > 0)
    .map(workspaceId => {
      const workspace = byId.get(workspaceId);
      return workspace === undefined
        ? { workspaceId, title: null, path: null, missing: true }
        : {
          workspaceId,
          title: workspaceName(workspace),
          path: typeof workspace.path === 'string' ? workspace.path : null,
          missing: false,
        };
    });
}
