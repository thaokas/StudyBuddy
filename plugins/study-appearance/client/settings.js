/**
 * Appearance row in Settings → General.
 *
 * The row is the only user-facing control of the plugin: it toggles the
 * StudyBuddy palette and picks one light pack and one dark pack. Each chip
 * previews the three surfaces the pack owns (sidebar / canvas / top bar) as a
 * three-swatch strip. State flows through the injected `useAppearance` hook and
 * the setter callbacks; the row never reaches for the client context.
 *
 * Typography and geometry follow the appearance design spec §5/§6: 14/22 row
 * title, 12/18 description and hint, 44px R12 preview, 12/18 pill chips.
 */
import { createElement as h } from 'react';
import { LOGO_URL } from './brand.js';
import { DARK_PACKS, LIGHT_PACKS } from './theme.js';

const LABEL_ID = 'study-appearance-setting-label';

const ROW_STYLE = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '12px 0',
  flexWrap: 'wrap',
};
const TEXT_STYLE = { display: 'flex', flexDirection: 'column', gap: '6px', flex: '1 1 280px', minWidth: 0 };
const LABEL_STYLE = { fontSize: '14px', lineHeight: '22px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' };
const DESCRIPTION_STYLE = {
  margin: 0,
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
  maxWidth: '46ch',
};
const HINT_STYLE = { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' };
const PACKS_STYLE = { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px' };
const PACK_GROUP_STYLE = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' };
const PACK_GROUP_LABEL_STYLE = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', minWidth: '52px' };
const CHIP_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' };
const SIDE_STYLE = { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px', flex: 'none' };
const PREVIEW_STYLE = {
  width: 44,
  height: 44,
  objectFit: 'contain',
  borderRadius: '12px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  padding: '4px',
  boxSizing: 'border-box',
};
const CHIP_BASE = {
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  border: '0.5px solid var(--dsw-alias-border-l3)',
  borderRadius: '999px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  padding: '3px 10px',
  fontSize: '12px',
  lineHeight: '18px',
  cursor: 'pointer',
};
const CHIP_ACTIVE = {
  ...CHIP_BASE,
  border: '0.5px solid var(--dsw-alias-brand-primary)',
  background: 'var(--dsw-alias-button-primary-dimmed)',
  color: 'var(--dsw-alias-brand-text)',
};
const SWATCH_STRIP_STYLE = { display: 'inline-flex', gap: '2px', flex: 'none' };
const SWATCH_STYLE = {
  width: 8,
  height: 8,
  borderRadius: '2px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  boxSizing: 'border-box',
};
const SWITCH_BASE = {
  appearance: 'none',
  borderRadius: '999px',
  padding: '8px 14px',
  minWidth: '76px',
  border: '0.5px solid var(--dsw-alias-border-l3)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: '12px',
  lineHeight: '18px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const SWITCH_ON = {
  ...SWITCH_BASE,
  border: '0.5px solid var(--dsw-alias-brand-primary)',
  background: 'var(--dsw-alias-button-primary-dimmed)',
  color: 'var(--dsw-alias-brand-text)',
};

/**
 * Render one palette group (light or dark).
 * @param {object} props - Group props.
 * @param {string} props.title - Localized group title.
 * @param {object[]} props.packs - Palette packs of the group.
 * @param {string} props.selected - Currently selected pack id.
 * @param {(id: string) => void} props.onSelect - Pack selection callback.
 * @param {string} props.testidPrefix - Stable `data-testid` prefix.
 * @param {(key: string) => string} props.t - Locale lookup.
 * @returns {object} Group element.
 */
function PackGroup({ title, packs, selected, onSelect, testidPrefix, t }) {
  return h('div', { style: PACK_GROUP_STYLE, role: 'group', 'aria-label': title },
    h('span', { style: PACK_GROUP_LABEL_STYLE, 'aria-hidden': 'true' }, title),
    h('div', { style: CHIP_ROW_STYLE },
      packs.map(pack => h('button', {
        key: pack.id,
        type: 'button',
        style: selected === pack.id ? CHIP_ACTIVE : CHIP_BASE,
        'aria-pressed': selected === pack.id ? 'true' : 'false',
        'data-testid': `${testidPrefix}-${pack.id}`,
        onClick: () => { onSelect(pack.id); },
      },
        h('span', { style: SWATCH_STRIP_STYLE, 'aria-hidden': 'true' },
          h('span', { style: { ...SWATCH_STYLE, background: pack.surfaces.sidebar } }),
          h('span', { style: { ...SWATCH_STYLE, background: pack.surfaces.base } }),
          h('span', { style: { ...SWATCH_STYLE, background: pack.surfaces.topbar } })),
        h('span', null, t(pack.labelKey))))));
}

/**
 * General settings row for the StudyBuddy appearance layer.
 * @param {{
 *   t: (key: string, params?: Record<string, unknown>) => string,
 *   useAppearance: (selector: (state: object) => unknown) => unknown,
 *   setEnabled: (value: boolean) => void,
 *   setLightPack: (value: string) => void,
 *   setDarkPack: (value: string) => void,
 * }} props - Locale seat and injected appearance actions.
 * @returns {object} Row element.
 */
export function AppearanceSettings({ t, useAppearance, setEnabled, setLightPack, setDarkPack }) {
  const state = useAppearance(snapshot => snapshot);
  return h('div', { 'data-testid': 'study-appearance-setting', style: ROW_STYLE },
    h('div', { style: TEXT_STYLE },
      h('span', { id: LABEL_ID, style: LABEL_STYLE }, t('appearance.setting.label')),
      h('p', { style: DESCRIPTION_STYLE }, t('appearance.setting.description')),
      h('div', { style: PACKS_STYLE },
        h(PackGroup, {
          key: 'light',
          title: t('appearance.light.label'),
          packs: Object.values(LIGHT_PACKS),
          selected: state.lightPack,
          onSelect: setLightPack,
          testidPrefix: 'study-appearance-light',
          t,
        }),
        h(PackGroup, {
          key: 'dark',
          title: t('appearance.dark.label'),
          packs: Object.values(DARK_PACKS),
          selected: state.darkPack,
          onSelect: setDarkPack,
          testidPrefix: 'study-appearance-dark',
          t,
        })),
      h('p', { style: HINT_STYLE }, t('appearance.hint.native')),
      h('p', { style: HINT_STYLE }, t('appearance.restore'))),
    h('div', { style: SIDE_STYLE },
      h('img', {
        src: LOGO_URL,
        alt: t('appearance.preview.alt'),
        style: PREVIEW_STYLE,
        'data-testid': 'study-appearance-preview',
      }),
      h('button', {
        type: 'button',
        role: 'switch',
        style: state.enabled ? SWITCH_ON : SWITCH_BASE,
        'aria-checked': state.enabled ? 'true' : 'false',
        'aria-labelledby': LABEL_ID,
        'data-testid': 'study-appearance-toggle',
        onClick: () => { setEnabled(!state.enabled); },
      }, t(state.enabled ? 'appearance.setting.enabled' : 'appearance.setting.disabled'))));
}
