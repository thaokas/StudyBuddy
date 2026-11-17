/**
 * Brand artwork for the StudyBuddy appearance layer.
 *
 * The plush buddy from `assets/logo1.png` (451×423 RGBA, transparent) ships
 * inside the client bundle as a data URL, so the logo works offline and needs
 * no extra static route. The sidebar slot only gives the mark 24px, where the
 * full-body pose turns to mush, so the mark uses a square head crop derived
 * from the same artwork (`client/assets/logo1-head.png`, cropped 250×250 around
 * the leaf / cap / face). The 34px empty-home hero and the 44px settings
 * preview keep the complete pose. The transparent images keep their own safety
 * margin; components never crop, recolor, round, or shadow them. The DSH slots
 * own geometry: the sidebar passes 24px, the empty-home hero 34px.
 */
import { createElement as h } from 'react';
import logo from './assets/logo1.png';
import logoHead from './assets/logo1-head.png';

/** Product name shown beside the sidebar mark. */
export const BRAND_NAME = 'StudyBuddy';

/** Complete plush portrait (451×423); used by the hero and the settings preview. */
export const LOGO_URL = logo;

/** Square head crop derived from {@link LOGO_URL}; used by the 24px sidebar mark. */
export const MARK_URL = logoHead;

/**
 * Sidebar brand mark (`sidebar.brand.mark`).
 * @param {{ size?: number }} props - Owner geometry from the sidebar.
 * @returns {object} Buddy head-crop image element.
 */
export function BrandMark({ size = 24 }) {
  return h('img', {
    src: MARK_URL,
    width: size,
    height: size,
    alt: '',
    'aria-hidden': 'true',
    draggable: false,
    decoding: 'async',
    'data-testid': 'study-brand-mark',
    'data-study-brand-mark': '',
    style: { objectFit: 'contain', display: 'block' },
  });
}

/**
 * Sidebar brand name (`sidebar.brand.name`). The slot owner fixes the 24px row,
 * so the wordmark uses the same line height and does not grow the sidebar.
 * @returns {object} Wordmark element.
 */
export function BrandName() {
  return h('span', {
    'data-testid': 'study-brand-name',
    style: {
      display: 'inline-block',
      fontSize: '18px',
      lineHeight: '24px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'var(--dsw-font-family-brand, var(--dsw-font-family, inherit))',
      whiteSpace: 'nowrap',
    },
  }, BRAND_NAME);
}

/**
 * Empty-home hero mark (`conversation.hero.brand.mark`).
 * @param {{ size?: number, className?: string }} props - Owner geometry from the hero.
 * @returns {object} Full-body plush image element.
 */
export function HeroBrandMark({ size = 34, className }) {
  return h('img', {
    src: LOGO_URL,
    width: size,
    height: size,
    alt: '',
    'aria-hidden': 'true',
    draggable: false,
    decoding: 'async',
    className,
    'data-testid': 'study-hero-brand-mark',
    'data-study-hero-brand-mark': '',
    style: { objectFit: 'contain', display: 'block' },
  });
}
