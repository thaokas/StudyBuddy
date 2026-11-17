/**
 * One plugin-owned global stylesheet for the appearance layer.
 *
 * The palette lives in theme tokens, so this sheet only adds what alias tokens
 * cannot express: the top-bar surface DSH has no token for, text selection,
 * and accessibility fallbacks. It uses semantic tokens only — no
 * `!important`, no DSH hashed class names, no gradients or background images,
 * no global `body` selector, so a DSH upgrade cannot silently pin stale colors.
 *
 * The top-bar rule targets the two stable DOM marks the Web shell publishes:
 * `header[data-window-drag]` is the main conversation header (40px on the blank
 * home, 76px with a conversation) and `[data-dockkit-strip]` is the right
 * rail / floating-panel tab strip. Both read the plugin-owned `--study-topbar`
 * token, so the layer stays inactive while the switch is off.
 */

/** DOM id of the injected stylesheet; one plugin instance owns it. */
export const STYLE_ID = 'study-appearance-styles';

/** CSS text injected once per page. */
export const STYLE_TEXT = `
:root[data-study-appearance='on'] header[data-window-drag],
:root[data-study-appearance='on'] [data-dockkit-strip] {
  background: var(--study-topbar);
  transition: background-color 160ms ease;
}

:root[data-study-appearance='on'] ::selection {
  background: var(--dsw-alias-bg-document-selection);
  color: var(--dsw-alias-label-primary);
}

:root[data-study-appearance='on'] [data-study-brand-mark],
:root[data-study-appearance='on'] [data-study-hero-brand-mark] {
  object-fit: contain;
  display: block;
}

@media (prefers-contrast: more) {
  :root[data-study-appearance='on'] ::selection {
    background: var(--dsw-alias-label-primary);
    color: var(--dsw-alias-label-primary-foreground);
  }
}

@media (prefers-reduced-transparency: reduce) {
  :root[data-study-appearance='on'] ::selection {
    background: var(--dsw-alias-bg-document-selection);
  }
}

@media (prefers-reduced-motion: reduce) {
  :root[data-study-appearance='on'] header[data-window-drag],
  :root[data-study-appearance='on'] [data-dockkit-strip],
  :root[data-study-appearance='on'] [data-study-brand-mark],
  :root[data-study-appearance='on'] [data-study-hero-brand-mark] {
    transition: none;
    animation: none;
  }
}

@media (forced-colors: active) {
  :root[data-study-appearance='on'] ::selection {
    background: Highlight;
    color: HighlightText;
  }
}
`.trim();

/**
 * Install the stylesheet and keep the root appearance attributes in sync.
 * @param {Document} doc - Document the stylesheet is installed into.
 * @param {{ snapshot: object, subscribe: (listener: Function) => Function }} store - Appearance store.
 * @returns {() => void} Disposer that removes the element and its attributes.
 */
export function installStyleSheet(doc, store) {
  if (doc === undefined || doc === null || doc.head === undefined) return () => {};
  const root = doc.documentElement;
  if (root === undefined || root === null) return () => {};
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute('data-study-appearance', 'stylesheet');
  style.textContent = STYLE_TEXT;
  doc.head.appendChild(style);

  /** Mirror the store snapshot onto the root dataset used by the CSS above. */
  const sync = () => {
    root.dataset.studyAppearance = store.snapshot.enabled ? 'on' : 'off';
    root.dataset.studyLightPack = store.snapshot.lightPack;
    root.dataset.studyDarkPack = store.snapshot.darkPack;
  };
  sync();
  const off = store.subscribe(sync);
  return () => {
    off();
    style.remove?.();
    delete root.dataset.studyAppearance;
    delete root.dataset.studyLightPack;
    delete root.dataset.studyDarkPack;
  };
}
