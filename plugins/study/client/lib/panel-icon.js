/**
 * Sidebar entry glyph for the study panels. Drawn inline so the plugin needs
 * no icon package and the entry carries no text that would need a locale.
 */
import { createElement as h } from 'react';

/**
 * Render one sidebar rail glyph.
 * @param {{ size?: number }} props - Owner-provided glyph size.
 * @returns {object} SVG element.
 */
export function StudyPanelIcon({ size = 18 }) {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  },
  h('path', { d: 'M4 5.6A2.6 2.6 0 0 1 6.6 3H19v14.4H6.6A2.6 2.6 0 0 0 4 20z' }),
  h('path', { d: 'M4 20a2.6 2.6 0 0 1 2.6-2.4H19V21H6.6A2.6 2.6 0 0 1 4 20z' }),
  h('path', { d: 'M8.4 7.6h6.4' }),
  h('path', { d: 'M8.4 11.2h4.4' }));
}
