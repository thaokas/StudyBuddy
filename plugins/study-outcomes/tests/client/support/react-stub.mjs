/**
 * Minimal `react` stand-in for Node-side client tests.
 *
 * Page modules import React, which this workspace cannot resolve outside the
 * browser bundle. Tests install the resolver hook, then import the page: the
 * returned element is a plain `{ type, props, children }` tree, so rendering
 * can be asserted without a DOM or a renderer. Hooks answer their initial
 * value only; state transitions are covered by the browser smoke.
 */
import { registerHooks } from 'node:module';

const self = new URL('./react-stub.mjs', import.meta.url).href;

/**
 * Route every `react` specifier of this process to this module.
 * Must run before the `import()` that loads a page or the plugin.
 */
export function installReactStub() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'react') return { url: self, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}

/**
 * Build one element node.
 * @param {string | Function} type - Tag or component.
 * @param {object | null} props - Element props.
 * @param {...unknown} children - Child nodes.
 * @returns {{ type: unknown, props: object, children: unknown[] }} Element.
 */
export function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children };
}

/** Fragment marker for tests that render lists. */
export const Fragment = Symbol('Fragment');

/**
 * Initial-value `useState` stand-in.
 * @param {unknown} initial - Initial value or initializer.
 * @returns {[unknown, () => void]} Value and a no-op setter.
 */
export function useState(initial) {
  return [typeof initial === 'function' ? initial() : initial, () => {}];
}

/** No-op `useEffect` stand-in. */
export function useEffect() {}

/**
 * `useCallback` stand-in returning the callback unchanged.
 * @param {Function} callback - Callback.
 * @returns {Function} The same callback.
 */
export function useCallback(callback) {
  return callback;
}

/**
 * `useMemo` stand-in evaluating once per render.
 * @param {Function} factory - Value factory.
 * @returns {unknown} Factory result.
 */
export function useMemo(factory) {
  return factory();
}

/**
 * `useSyncExternalStore` stand-in reading the current snapshot.
 * @param {Function} _subscribe - Subscription function (ignored).
 * @param {Function} getSnapshot - Snapshot reader.
 * @returns {unknown} Current snapshot.
 */
export function useSyncExternalStore(_subscribe, getSnapshot) {
  return getSnapshot();
}
