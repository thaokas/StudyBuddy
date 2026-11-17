/**
 * In-process refresh signal for the study surfaces.
 *
 * The plan page, the workbench, and the compact overview all read the same task
 * service, but a write on one surface cannot see the others' state. This tiny
 * publisher lets one surface announce a committed change so another mounted
 * surface re-reads without a page reload. It holds no state and never keeps a
 * caller alive: subscriptions are explicit and return their remover.
 */

export function createStudyRefresh() {
  const listeners = new Set();

  /**
   * Announce that study data changed. A failing subscriber never blocks the
   * write that already succeeded.
   * @param {string} [reason] - Short diagnostic label for the changed surface.
   */
  function notifyStudyDataChanged(reason = 'general') {
    for (const listener of [...listeners]) {
      try {
        listener(reason);
      } catch (error) {
        console.warn('[study] a data-change subscriber failed:', error);
      }
    }
  }

  /**
   * Subscribe to study data changes.
   * @param {(reason: string) => void} listener - Called after a committed write.
   * @returns {() => void} Remover.
   */
  function onStudyDataChanged(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return { notifyStudyDataChanged, onStudyDataChanged, dispose: () => listeners.clear() };
}
