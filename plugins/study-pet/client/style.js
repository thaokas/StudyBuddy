/**
 * Stylesheet for the StudyBuddy pet overlay.
 *
 * One `<style>` element holds every rule: the floating root, the plush image,
 * the mirror wrapper, the bubble, the hover panel, the summon button, the
 * minimal motion set, and the accessibility fallbacks. The sheet is installed
 * by `installStyleSheet` and removed with its disposer, so disabling the
 * plugin leaves no residue.
 *
 * The pet image is the finished plush illustration (`client/assets/logo1.png`,
 * inlined as a data URL); pose-by-state animation is deferred, so the only
 * motion is a gentle breathe/float, a click squash, a double-click bounce, and
 * a drag tilt. The bubble and panel use semantic `--dsw-alias-*` tokens so they
 * track the host theme.
 */

/** Id of the injected style element. */
export const STYLE_ID = 'study-pet-styles';

/** Stylesheet text. */
export const STYLE_TEXT = `
[data-study-pet] {
  position: fixed;
  z-index: 30;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  --sp-flip: 1;
  --sp-tilt: 0deg;
}

[data-study-pet][data-mirror='true'] {
  /* Mirrored when the pet is on the right half of the viewport, so it faces
     into the page; the wrapper only flips horizontally and never squashes. */
  --sp-flip: -1;
}

[data-study-pet][data-dragging='true'] {
  --sp-tilt: 6deg;
}

[data-study-pet] .sp-button {
  pointer-events: auto;
  display: block;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: grab;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}

[data-study-pet][data-dragging='true'] .sp-button { cursor: grabbing; }

[data-study-pet] .sp-photo-frame {
  display: block;
  width: 100%;
  height: 100%;
  transform-origin: 50% 62%;
  transform: scaleX(var(--sp-flip)) rotate(var(--sp-tilt));
  transition: transform 160ms ease;
}

[data-study-pet] .sp-figure,
[data-study-pet] .sp-photo {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: 50% 50%;
  transform-origin: 50% 62%;
  animation: sp-photo-breathe 4.2s ease-in-out infinite;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}

[data-study-pet][data-squash='true'] .sp-photo {
  animation: sp-photo-squash 280ms ease-out;
}

[data-study-pet][data-happy='true'] .sp-photo {
  animation: sp-photo-bounce 0.55s ease-in-out 2;
}

[data-study-pet][data-state='dragging'] .sp-photo { animation: none; }

[data-study-pet] .sp-button:focus-visible,
[data-study-pet] .sp-panel button:focus-visible,
[data-study-pet-summon]:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, #476F20);
  outline-offset: 2px;
}

/* ---- Bubble ---- */

[data-study-pet] .sp-bubble {
  pointer-events: none;
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  box-sizing: border-box;
  max-width: min(260px, 56vw);
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #FFFCF4);
  color: var(--dsw-alias-label-primary, #2E251C);
  border: 0.5px solid var(--dsw-alias-border-l3, #D5C7B0);
  box-shadow: var(--dsw-elevation-panel, 0 3px 8px rgba(0, 0, 0, 0.08));
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  animation: sp-bubble-in 160ms ease-out;
}

[data-study-pet] .sp-bubble[data-kind='chatter'] {
  color: var(--dsw-alias-label-secondary, #594C40);
  font-style: italic;
}

[data-study-pet] .sp-bubble[data-kind='dream'] {
  color: var(--dsw-alias-label-secondary, #594C40);
}

[data-study-pet] .sp-bubble::after {
  content: '';
  position: absolute;
  right: 26px;
  bottom: -5px;
  width: 9px;
  height: 9px;
  transform: rotate(45deg);
  background: inherit;
  border-right: 0.5px solid var(--dsw-alias-border-l3, #D5C7B0);
  border-bottom: 0.5px solid var(--dsw-alias-border-l3, #D5C7B0);
}

[data-study-pet][data-flip='true'] .sp-bubble {
  bottom: auto;
  top: calc(100% + 10px);
}

[data-study-pet][data-flip='true'] .sp-bubble::after {
  bottom: auto;
  top: -5px;
  border-right: 0;
  border-bottom: 0;
  border-left: 0.5px solid var(--dsw-alias-border-l3, #D5C7B0);
  border-top: 0.5px solid var(--dsw-alias-border-l3, #D5C7B0);
}

/* ---- Hover / focus panel ---- */

[data-study-pet] .sp-panel {
  pointer-events: auto;
  position: absolute;
  top: 50%;
  right: calc(100% + 6px);
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #FFFCF4);
  border: 0.5px solid var(--dsw-alias-border-l3, #D5C7B0);
  box-shadow: var(--dsw-elevation-panel, 0 3px 8px rgba(0, 0, 0, 0.08));
  opacity: 0;
  visibility: hidden;
  transition: opacity 120ms ease;
}

[data-study-pet][data-side='right'] .sp-panel {
  right: auto;
  left: calc(100% + 6px);
}

[data-study-pet]:hover .sp-panel,
[data-study-pet]:focus-within .sp-panel {
  opacity: 1;
  visibility: visible;
}

[data-study-pet] .sp-panel button {
  appearance: none;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #594C40);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);
  font-size: 12px;
  line-height: 18px;
  padding: 3px 8px;
  white-space: nowrap;
  cursor: pointer;
}

[data-study-pet] .sp-panel button:hover {
  background: var(--dsw-alias-interactive-bg-hover, #EFE6D2);
  color: var(--dsw-alias-label-primary, #2E251C);
}

/* ---- Summon button (pet hidden) ---- */

[data-study-pet-summon] {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 30;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: 999px;
  border: 0.5px solid var(--dsw-alias-border-l3, #D5C7B0);
  background: var(--dsw-alias-bg-layer-1, #FFFCF4);
  color: var(--dsw-alias-label-primary, #2E251C);
  font-size: 19px;
  line-height: 1;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: var(--dsw-elevation-panel, 0 3px 8px rgba(0, 0, 0, 0.08));
}

/* ---- Minimal motion ---- */

@keyframes sp-bubble-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes sp-photo-breathe {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-2px) scale(1.012); }
}

@keyframes sp-photo-squash {
  0% { transform: scale(1, 1); }
  40% { transform: scale(1.06, 0.9) translateY(2px); }
  100% { transform: scale(1, 1); }
}

@keyframes sp-photo-bounce {
  0%, 100% { transform: translateY(0); }
  45% { transform: translateY(-8px); }
  72% { transform: translateY(0) scale(1.02, 0.98); }
}

/* ---- Accessibility fallbacks ---- */

@media (prefers-reduced-motion: reduce) {
  /*
   * Some motion rules are state-keyed (0,3,0), so this fallback repeats the
   * same structure instead of relying on a universal child selector: equal
   * specificity plus source order wins. The generic rule stays as a safety net
   * for future additions.
   */
  [data-study-pet] *,
  [data-study-pet] *::before,
  [data-study-pet] *::after {
    animation: none;
    transition: none;
  }

  [data-study-pet] .sp-photo,
  [data-study-pet] .sp-figure,
  [data-study-pet] .sp-photo-frame,
  [data-study-pet][data-squash='true'] .sp-photo,
  [data-study-pet][data-happy='true'] .sp-photo,
  [data-study-pet] .sp-bubble,
  [data-study-pet] .sp-panel {
    animation: none;
    transition: none;
  }

  [data-study-pet][data-dragging='true'] .sp-photo-frame {
    transform: scaleX(var(--sp-flip));
  }
}

@media (prefers-contrast: more) {
  [data-study-pet] .sp-bubble,
  [data-study-pet] .sp-panel,
  [data-study-pet-summon] {
    background: var(--dsw-alias-bg-layer-1, #FFFCF4);
    border: 1px solid var(--dsw-alias-border-l4, #C4B49A);
  }

  [data-study-pet] .sp-bubble { color: var(--dsw-alias-label-primary, #2E251C); }
}

@media (forced-colors: active) {
  [data-study-pet] .sp-bubble,
  [data-study-pet] .sp-panel,
  [data-study-pet] .sp-panel button,
  [data-study-pet-summon] {
    background: Canvas;
    color: CanvasText;
    border: 1px solid CanvasText;
    forced-color-adjust: none;
  }

  [data-study-pet] .sp-bubble::after {
    background: Canvas;
    border: 1px solid CanvasText;
  }
}
`.trim();

/**
 * Install the stylesheet once for this plugin instance.
 * @param {Document | undefined} doc - Document to install into.
 * @returns {() => void} Disposer removing the style element.
 */
export function installStyleSheet(doc) {
  if (doc === undefined || doc === null || doc.head === undefined) return () => {};
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute('data-study-pet-styles', 'stylesheet');
  style.textContent = STYLE_TEXT;
  doc.head.appendChild(style);
  return () => { style.remove?.(); };
}
