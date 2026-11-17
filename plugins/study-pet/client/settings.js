/**
 * Settings → General row for the StudyBuddy pet.
 *
 * The row is the stable control surface: show/hide, chatter on/off, and the
 * three scales. It shares the one store with the floating pet, so hiding the
 * pet from its hover panel also flips this row's switch. State arrives through
 * the injected `usePet` hook and the three setter callbacks; the row never
 * reaches for the client context.
 *
 * Geometry follows the appearance plugin's settings row: 14/22 title, 12/18
 * description and hint, 12/18 pill chips, and a right-aligned switch.
 */
import { createElement as h } from 'react';

const LABEL_ID = 'study-pet-setting-label';

const ROW_STYLE = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '12px 0',
  flexWrap: 'wrap',
};
const TEXT_STYLE = { display: 'flex', flexDirection: 'column', gap: '6px', flex: '1 1 240px', minWidth: 0 };
const LABEL_STYLE = { fontSize: '14px', lineHeight: '22px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' };
const DESCRIPTION_STYLE = {
  margin: 0,
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
  maxWidth: '46ch',
};
const HINT_STYLE = { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' };
const CONTROLS_STYLE = { display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-end' };
const CONTROL_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' };
const CONTROL_LABEL_STYLE = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' };
const CHIP_BASE = {
  appearance: 'none',
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
const SWITCH_BASE = {
  appearance: 'none',
  borderRadius: '999px',
  padding: '5px 12px',
  minWidth: '64px',
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

/** Selectable scales and their dictionary keys. */
const SIZE_CHOICES = Object.freeze([
  Object.freeze({ id: '0.85', labelKey: 'pet.setting.size.0.85' }),
  Object.freeze({ id: '1', labelKey: 'pet.setting.size.1' }),
  Object.freeze({ id: '1.2', labelKey: 'pet.setting.size.1.2' }),
]);

/**
 * General settings row for the StudyBuddy pet.
 * @param {{
 *   t: (key: string) => string,
 *   usePet: (selector: (state: object) => unknown) => unknown,
 *   setEnabled: (value: boolean) => void,
 *   setChatter: (value: boolean) => void,
 *   setSize: (value: string) => void,
 * }} props - Locale seat, store hook, and setters.
 * @returns {object} Row element.
 */
export function PetSettings({ t, usePet, setEnabled, setChatter, setSize }) {
  const state = usePet(snapshot => snapshot);
  return h('div', { 'data-testid': 'study-pet-setting', style: ROW_STYLE },
    h('div', { style: TEXT_STYLE },
      h('span', { id: LABEL_ID, style: LABEL_STYLE }, t('pet.setting.label')),
      h('p', { style: DESCRIPTION_STYLE }, t('pet.setting.description')),
      h('p', { style: HINT_STYLE }, t('pet.setting.hint'))),
    h('div', { style: CONTROLS_STYLE },
      h('div', { style: CONTROL_ROW_STYLE },
        h('span', { style: CONTROL_LABEL_STYLE }, t('pet.setting.visible')),
        h('button', {
          type: 'button',
          role: 'switch',
          style: state.enabled ? SWITCH_ON : SWITCH_BASE,
          'aria-checked': state.enabled ? 'true' : 'false',
          'aria-labelledby': LABEL_ID,
          'data-testid': 'study-pet-toggle',
          onClick: () => { setEnabled(!state.enabled); },
        }, t(state.enabled ? 'pet.setting.shown' : 'pet.setting.hidden'))),
      h('div', { style: CONTROL_ROW_STYLE },
        h('span', { style: CONTROL_LABEL_STYLE }, t('pet.setting.chatter')),
        h('button', {
          type: 'button',
          role: 'switch',
          style: state.chatter ? SWITCH_ON : SWITCH_BASE,
          'aria-checked': state.chatter ? 'true' : 'false',
          'data-testid': 'study-pet-chatter',
          onClick: () => { setChatter(!state.chatter); },
        }, t(state.chatter ? 'pet.setting.chatterOn' : 'pet.setting.chatterOff'))),
      h('div', { style: CONTROL_ROW_STYLE },
        h('span', { style: CONTROL_LABEL_STYLE }, t('pet.setting.size')),
        SIZE_CHOICES.map(choice => h('button', {
          key: choice.id,
          type: 'button',
          style: state.size === choice.id ? CHIP_ACTIVE : CHIP_BASE,
          'aria-pressed': state.size === choice.id ? 'true' : 'false',
          'data-testid': `study-pet-size-${choice.id}`,
          onClick: () => { setSize(choice.id); },
        }, t(choice.labelKey))))));
}
