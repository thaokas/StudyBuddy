/**
 * StudyBuddy appearance palette groups.
 *
 * The plugin never replaces DSH's theme preference: it stacks one alias-token
 * override layer over the active built-in light or dark palette through
 * `ctx.theme.overrideTokens()`. A palette group ("pack") therefore supplies the
 * three surfaces a student picks — sidebar, canvas, top bar — plus the raised
 * surfaces derived from them, and the token layer combines one light pack with
 * one dark pack so the values stay paired when DSH flips the native scheme.
 *
 * Light family: sprout paper greens. Dark family: night-sail blues. Both pack
 * families share their family's text, border, state, accent, and control
 * colors; only the surfaces change per pack. This module stays React-free so
 * Node tests can validate completeness and contrast.
 */

/** Source name of the override layer; appears in DSH theme diagnostics. */
export const SOURCE = '@studybuddy/study-appearance';

/** Surface roles every pack assigns; the settings row previews the first three. */
export const SURFACE_ROLES = Object.freeze([
  'sidebar',
  'base',
  'topbar',
  'layer1',
  'layer2',
  'layer3',
  'overlay',
  'input',
  'bubble',
  'navActive',
]);

/** Light packs, in settings-row order. */
export const LIGHT_PACKS = Object.freeze({
  'sprout-paper': pack('light', 'sprout-paper', 'appearance.pack.sprout-paper', 'Sprout Paper', {
    base: '#FBF7EC',
    sidebar: '#EFF5E3',
    topbar: '#E3EDD2',
    layer1: '#FFFDF7',
    layer2: '#F6F2E5',
    layer3: '#EFEADA',
    overlay: '#E7E1CF',
    input: '#FFFDF8',
    bubble: '#F6F2E5',
    navActive: '#E3ECD5',
  }),
  'mint-mist': pack('light', 'mint-mist', 'appearance.pack.mint-mist', 'Mint Mist', {
    base: '#EDF5E7',
    sidebar: '#F8FBF3',
    topbar: '#DCEBD0',
    layer1: '#FBFEF7',
    layer2: '#EFF6E9',
    layer3: '#E5EFDC',
    overlay: '#D9E7CE',
    input: '#FCFEF9',
    bubble: '#EFF6E9',
    navActive: '#E1EDD8',
  }),
  'celadon-page': pack('light', 'celadon-page', 'appearance.pack.celadon-page', 'Celadon Page', {
    base: '#F6F9F0',
    sidebar: '#E1EDD7',
    topbar: '#FBFDF7',
    layer1: '#FCFEF9',
    layer2: '#F1F7EA',
    layer3: '#E8F1DE',
    overlay: '#DCE9D2',
    input: '#FCFEF9',
    bubble: '#F1F7EA',
    navActive: '#EAF2E1',
  }),
});

/** Dark packs, in settings-row order. */
export const DARK_PACKS = Object.freeze({
  'deep-sea': pack('dark', 'deep-sea', 'appearance.pack.deep-sea', 'Deep Sea', {
    base: '#0F1A2A',
    sidebar: '#0B1523',
    topbar: '#0A1420',
    layer1: '#142234',
    layer2: '#182942',
    layer3: '#1E3250',
    overlay: '#22395A',
    input: '#132032',
    bubble: '#182942',
    navActive: '#1D304B',
  }),
  'midnight-indigo': pack('dark', 'midnight-indigo', 'appearance.pack.midnight-indigo', 'Midnight Indigo', {
    base: '#0B1522',
    sidebar: '#111E33',
    topbar: '#16294A',
    layer1: '#122033',
    layer2: '#16273D',
    layer3: '#1C304B',
    overlay: '#203757',
    input: '#111E31',
    bubble: '#16273D',
    navActive: '#1C304B',
  }),
  'starry-blue': pack('dark', 'starry-blue', 'appearance.pack.starry-blue', 'Starry Blue', {
    base: '#0D1728',
    sidebar: '#0A1220',
    topbar: '#1A2E4F',
    layer1: '#132136',
    layer2: '#17283F',
    layer3: '#1D3150',
    overlay: '#21395D',
    input: '#121F33',
    bubble: '#17283F',
    navActive: '#1E3453',
  }),
});

/** Light pack picked when no stored value exists or the stored value is unknown. */
export const DEFAULT_LIGHT_PACK = 'sprout-paper';
/** Dark pack picked when no stored value exists or the stored value is unknown. */
export const DEFAULT_DARK_PACK = 'deep-sea';

/**
 * Family colors shared by the three light packs: text, hairlines, controls,
 * states, accent, selection, scrollbar. Values are the readable track; the
 * accents are deliberately dark enough for the palest pack surface.
 */
const LIGHT_FAMILY = Object.freeze({
  primary: '#20301A',
  secondary: '#46563B',
  tertiary: '#56664A',
  caption: '#5F6F51',
  dimmed: '#9AA88B',
  foreground: '#FDFCF7',
  border1: '#E6EEDC',
  border2: '#D6E1C8',
  border3: '#C5D4B4',
  border4: '#B3C5A0',
  hover: '#EDF3E3',
  active: '#E2ECD4',
  success: '#3F6B2C',
  successTertiary: '#E6EDD6',
  warn: '#8A6118',
  warnLabel: '#7A5510',
  warnTertiary: '#F4E5C8',
  error: '#A33B33',
  errorTertiary: '#F6E0DD',
  business: '#3E5F57',
  businessTertiary: '#E0EAE5',
  idle: '#7C8B6B',
  done: '#56664A',
  scrollbar: '#7E8B6C',
  scrollbarHover: '#6B7859',
  switchThumb: '#FDFCF7',
  accent: '#3F6B26',
  accentHover: '#35591F',
  accentDimmed: '#E3EED3',
  accentSelection: '#D9E8C4',
  infoFill: '#3F6B26',
  infoHover: '#35591F',
  brandSignal: '#3F6B26',
});

/**
 * Family colors shared by the three dark packs. The accent lifts to a readable
 * night blue; the surfaces are supplied per pack.
 */
const DARK_FAMILY = Object.freeze({
  primary: '#E6EEF9',
  secondary: '#B9C8DC',
  tertiary: '#93A6BE',
  caption: '#8C9EB4',
  dimmed: '#5E6F85',
  foreground: '#0A1422',
  border1: '#1B2A3E',
  border2: '#263A54',
  border3: '#314866',
  border4: '#3D5678',
  hover: '#152235',
  active: '#1C2C44',
  success: '#7FD3A0',
  successTertiary: '#14301F',
  warn: '#E8B45E',
  warnLabel: '#F0C079',
  warnTertiary: '#322610',
  error: '#F58A82',
  errorTertiary: '#331B19',
  business: '#83B7D9',
  businessTertiary: '#14282F',
  idle: '#6B7D93',
  done: '#93A6BE',
  scrollbar: '#5E6F85',
  scrollbarHover: '#73869C',
  switchThumb: '#E6EEF9',
  accent: '#86B4FF',
  accentHover: '#A2C6FF',
  accentDimmed: '#1E3350',
  accentSelection: '#223E66',
  infoFill: '#4E7FD8',
  infoHover: '#3F6FC4',
  brandSignal: '#4E7FD8',
});

/**
 * Token name to surface role. Each row reads the light value from the light
 * pack and the dark value from the dark pack.
 */
const SURFACE_TOKENS = Object.freeze({
  '--dsw-alias-bg-base': 'base',
  '--dsw-alias-bg-layer-1': 'layer1',
  '--dsw-alias-bg-layer-2': 'layer2',
  '--dsw-alias-bg-layer-3': 'layer3',
  '--dsw-alias-bg-overlay': 'overlay',
  '--dsw-alias-bg-skeleton': 'layer3',
  '--dsw-specific-sidebar-fill': 'sidebar',
  '--dsw-specific-sidebar-nav-item-active': 'navActive',
  '--dsw-specific-input-major': 'input',
  '--dsw-specific-bubble': 'bubble',
  '--dsw-specific-bubble-highlight': 'layer3',
  '--dsw-specific-tip': 'layer2',
  '--dsw-specific-selector': 'layer3',
  '--dsw-alias-markdown-code-block': 'layer2',
  '--dsw-alias-markdown-code-block-banner': 'layer2',
  '--dsw-alias-markdown-inline-code': 'layer3',
  '--dsw-alias-markdown-code-segment-selected': 'input',
  '--dsw-alias-markdown-code-segment-unselected': 'layer2',
  '--dsw-alias-markdown-citation': 'layer2',
  '--dsw-alias-settings-card-fill': 'layer2',
  '--dsw-alias-button-elevated-fill': 'layer1',
  '--dsw-alias-button-floating-fill': 'layer1',
  '--dsw-alias-button-floating-hover': 'layer2',
  '--dsw-alias-turn-trigger-bg': 'layer2',
  '--study-topbar': 'topbar',
});

/**
 * Token name to shared family color role. These do not depend on the pack; a
 * light scheme reads the light family role and a dark scheme the dark family
 * role with the same name.
 */
const FAMILY_TOKENS = Object.freeze({
  '--dsw-alias-border-l1': 'border1',
  '--dsw-alias-border-l2': 'border2',
  '--dsw-alias-border-l3': 'border3',
  '--dsw-alias-border-l4': 'border4',
  '--dsw-alias-label-primary': 'primary',
  '--dsw-alias-label-secondary': 'secondary',
  '--dsw-alias-label-tertiary': 'tertiary',
  '--dsw-alias-label-caption': 'caption',
  '--dsw-alias-label-dimmed': 'dimmed',
  '--dsw-alias-label-primary-foreground': 'foreground',
  '--dsw-alias-label-primary-dimmed': 'secondary',
  '--dsw-alias-menu-icon': 'secondary',
  '--dsw-alias-interactive-bg-hover': 'hover',
  '--dsw-alias-interactive-bg-active': 'active',
  '--dsw-alias-state-success-primary': 'success',
  '--dsw-alias-state-success-tertiary': 'successTertiary',
  '--dsw-alias-state-warn-primary': 'warn',
  '--dsw-alias-state-warn-label': 'warnLabel',
  '--dsw-alias-state-warn-tertiary': 'warnTertiary',
  '--dsw-alias-state-error-primary': 'error',
  '--dsw-alias-state-business-primary': 'business',
  '--dsw-alias-state-business-tertiary': 'businessTertiary',
  '--dsw-alias-state-idle-primary': 'idle',
  '--dsw-alias-state-done-primary': 'done',
  '--dsw-alias-scrollbar-bg-l1': 'scrollbar',
  '--dsw-alias-scrollbar-hover-l1': 'scrollbarHover',
  '--dsw-alias-scrollbar-bg-l2': 'scrollbar',
  '--dsw-alias-scrollbar-hover-l2': 'scrollbarHover',
  '--dsw-alias-switch-thumb': 'switchThumb',
  '--dsw-alias-settings-card-stroke': 'border4',
  '--dsw-elevation-stroke-color': 'border4',
  '--dsw-alias-button-ghost-active-border': 'border3',
  '--dsw-alias-turn-trigger-bg-hover': 'hover',
  // Send circle and dockkit/trajectory signal color. DSH paints the send glyph
  // in a static #fff, so these fills are background-only in the dark family.
  '--dsw-alias-button-info-fill': 'infoFill',
  '--dsw-alias-button-info-hover': 'infoHover',
  '--dsw-alias-brand-primary-new-colorprimary-new-color': 'brandSignal',
});

/** Accent, button, focus, selection, and highlight tokens shared per family. */
const ACCENT_TOKENS = Object.freeze({
  '--dsw-alias-brand-primary': 'accent',
  '--dsw-alias-brand-text': 'accent',
  '--dsw-alias-link': 'accent',
  '--dsw-alias-button-primary-fill': 'accent',
  '--dsw-alias-button-primary-hover': 'accentHover',
  '--dsw-alias-button-primary-dimmed': 'accentDimmed',
  '--dsw-focus-ring-color': 'accent',
  '--dsw-alias-bg-document-selection': 'accentSelection',
  '--dsw-specific-sidebar-nav-item-active-accent': 'accentDimmed',
  '--dsw-alias-bg-multi-select': 'accentDimmed',
  '--dsw-alias-button-ghost-active-fill': 'accentDimmed',
});

/** Every token name the override layer writes, in a stable order. */
export const TOKEN_NAMES = Object.freeze([
  ...Object.keys(SURFACE_TOKENS),
  ...Object.keys(FAMILY_TOKENS),
  ...Object.keys(ACCENT_TOKENS),
]);

/**
 * Normalize an arbitrary stored value to a supported light pack id.
 * @param {unknown} value - Stored value from Web Storage.
 * @returns {string} Supported light pack id.
 */
export function normalizeLightPack(value) {
  return typeof value === 'string' && Object.hasOwn(LIGHT_PACKS, value) ? value : DEFAULT_LIGHT_PACK;
}

/**
 * Normalize an arbitrary stored value to a supported dark pack id.
 * @param {unknown} value - Stored value from Web Storage.
 * @returns {string} Supported dark pack id.
 */
export function normalizeDarkPack(value) {
  return typeof value === 'string' && Object.hasOwn(DARK_PACKS, value) ? value : DEFAULT_DARK_PACK;
}

/**
 * Read the three preview surfaces of one pack.
 * @param {string} id - Pack id; unknown ids fall back to the default light pack.
 * @returns {{ sidebar: string, base: string, topbar: string }} Preview swatches.
 */
export function packSwatches(id) {
  const pack = LIGHT_PACKS[id] ?? DARK_PACKS[id] ?? LIGHT_PACKS[DEFAULT_LIGHT_PACK];
  const { surfaces } = pack;
  return Object.freeze({ sidebar: surfaces.sidebar, base: surfaces.base, topbar: surfaces.topbar });
}

/**
 * Build the DSH theme-token override layer from one light pack and one dark
 * pack. Each token always carries both scheme values: the light value belongs
 * to the light pack family, the dark value to the dark pack family.
 * @param {string} [lightPack] - Light pack id; unknown values fall back to the default.
 * @param {string} [darkPack] - Dark pack id; unknown values fall back to the default.
 * @param {boolean} [enabled] - When false, return an empty layer so the native palette wins.
 * @returns {Record<string, { light: string, dark: string }>} Token override layer.
 */
export function tokenLayer(
  lightPack = DEFAULT_LIGHT_PACK,
  darkPack = DEFAULT_DARK_PACK,
  enabled = true,
) {
  if (enabled === false) return {};
  const light = LIGHT_PACKS[normalizeLightPack(lightPack)].surfaces;
  const dark = DARK_PACKS[normalizeDarkPack(darkPack)].surfaces;
  const layer = {};
  for (const [name, role] of Object.entries(SURFACE_TOKENS)) layer[name] = schemePair(light[role], dark[role]);
  for (const [name, role] of Object.entries(FAMILY_TOKENS)) layer[name] = schemePair(LIGHT_FAMILY[role], DARK_FAMILY[role]);
  for (const [name, role] of Object.entries(ACCENT_TOKENS)) layer[name] = schemePair(LIGHT_FAMILY[role], DARK_FAMILY[role]);
  return layer;
}

/**
 * Contrast pairs validated by the appearance test suite (design spec §4).
 * Only hex values are listed so the WCAG relative-luminance formula stays
 * unambiguous; every pair is re-run for all three light packs and all three
 * dark packs. Text pairs use 4.5:1 (WCAG AA, small text); non-text pairs use
 * 3:1 (WCAG 1.4.11). A foreground may be a literal `#RRGGBB` for glyphs DSH
 * paints in a fixed color; the send circle's arrow is a static `#fff`.
 */
export const CONTRAST_PAIRS = Object.freeze([
  contrastPair('light body text', 'light', '--dsw-alias-label-primary', '--dsw-alias-bg-base', 4.5),
  contrastPair('light body on sidebar', 'light', '--dsw-alias-label-primary', '--dsw-specific-sidebar-fill', 4.5),
  contrastPair('light body on top bar', 'light', '--dsw-alias-label-primary', '--study-topbar', 4.5),
  contrastPair('light body on nav active', 'light', '--dsw-alias-label-primary', '--dsw-specific-sidebar-nav-item-active', 4.5),
  contrastPair('light secondary text', 'light', '--dsw-alias-label-secondary', '--dsw-alias-bg-base', 4.5),
  contrastPair('light tertiary text', 'light', '--dsw-alias-label-tertiary', '--dsw-alias-bg-base', 4.5),
  contrastPair('light caption text', 'light', '--dsw-alias-label-caption', '--dsw-alias-bg-base', 4.5),
  contrastPair('light caption on layer 2', 'light', '--dsw-alias-label-caption', '--dsw-alias-bg-layer-2', 4.5),
  contrastPair('light accent text', 'light', '--dsw-alias-brand-primary', '--dsw-alias-bg-base', 4.5),
  contrastPair('light accent on layer 2', 'light', '--dsw-alias-brand-primary', '--dsw-alias-bg-layer-2', 4.5),
  contrastPair('light accent on top bar', 'light', '--dsw-alias-brand-primary', '--study-topbar', 4.5),
  contrastPair('light primary button label', 'light', '--dsw-alias-label-primary-foreground', '--dsw-alias-button-primary-fill', 4.5),
  contrastPair('light primary button hover label', 'light', '--dsw-alias-label-primary-foreground', '--dsw-alias-button-primary-hover', 4.5),
  contrastPair('light selection text', 'light', '--dsw-alias-label-primary', '--dsw-alias-bg-document-selection', 4.5),
  contrastPair('light focus ring', 'light', '--dsw-focus-ring-color', '--dsw-alias-bg-base', 3),
  contrastPair('light scrollbar thumb', 'light', '--dsw-alias-scrollbar-bg-l1', '--dsw-alias-bg-base', 3),
  contrastPair('light idle dot', 'light', '--dsw-alias-state-idle-primary', '--dsw-alias-bg-base', 3),
  contrastPair('light send glyph', 'light', '#FFFFFF', '--dsw-alias-button-info-fill', 3),
  contrastPair('light send glyph hover', 'light', '#FFFFFF', '--dsw-alias-button-info-hover', 3),
  contrastPair('dark body text', 'dark', '--dsw-alias-label-primary', '--dsw-alias-bg-base', 4.5),
  contrastPair('dark body on sidebar', 'dark', '--dsw-alias-label-primary', '--dsw-specific-sidebar-fill', 4.5),
  contrastPair('dark body on top bar', 'dark', '--dsw-alias-label-primary', '--study-topbar', 4.5),
  contrastPair('dark body on nav active', 'dark', '--dsw-alias-label-primary', '--dsw-specific-sidebar-nav-item-active', 4.5),
  contrastPair('dark secondary text', 'dark', '--dsw-alias-label-secondary', '--dsw-alias-bg-base', 4.5),
  contrastPair('dark tertiary text', 'dark', '--dsw-alias-label-tertiary', '--dsw-alias-bg-base', 4.5),
  contrastPair('dark caption text', 'dark', '--dsw-alias-label-caption', '--dsw-alias-bg-base', 4.5),
  contrastPair('dark caption on layer 2', 'dark', '--dsw-alias-label-caption', '--dsw-alias-bg-layer-2', 4.5),
  contrastPair('dark accent text', 'dark', '--dsw-alias-brand-primary', '--dsw-alias-bg-base', 4.5),
  contrastPair('dark accent on layer 2', 'dark', '--dsw-alias-brand-primary', '--dsw-alias-bg-layer-2', 4.5),
  contrastPair('dark accent on top bar', 'dark', '--dsw-alias-brand-primary', '--study-topbar', 4.5),
  contrastPair('dark primary button label', 'dark', '--dsw-alias-label-primary-foreground', '--dsw-alias-button-primary-fill', 4.5),
  contrastPair('dark primary button hover label', 'dark', '--dsw-alias-label-primary-foreground', '--dsw-alias-button-primary-hover', 4.5),
  contrastPair('dark selection text', 'dark', '--dsw-alias-label-primary', '--dsw-alias-bg-document-selection', 4.5),
  contrastPair('dark focus ring', 'dark', '--dsw-focus-ring-color', '--dsw-alias-bg-base', 3),
  contrastPair('dark scrollbar thumb', 'dark', '--dsw-alias-scrollbar-bg-l1', '--dsw-alias-bg-base', 3),
  contrastPair('dark idle dot', 'dark', '--dsw-alias-state-idle-primary', '--dsw-alias-bg-base', 3),
  contrastPair('dark send glyph', 'dark', '#FFFFFF', '--dsw-alias-button-info-fill', 3),
  contrastPair('dark send glyph hover', 'dark', '#FFFFFF', '--dsw-alias-button-info-hover', 3),
]);

/**
 * Freeze one palette pack.
 * @param {'light'|'dark'} scheme - Family the pack belongs to.
 * @param {string} id - Stable pack id used by storage, tests, and testids.
 * @param {string} labelKey - Dictionary key of the display name.
 * @param {string} name - English name used by docs and diagnostics.
 * @param {Record<string, string>} surfaces - Ten surface colors.
 * @returns {object} Frozen pack record.
 */
function pack(scheme, id, labelKey, name, surfaces) {
  const ordered = {};
  for (const role of SURFACE_ROLES) {
    const value = surfaces[role];
    if (typeof value !== 'string' || !/^#[0-9A-F]{6}$/i.test(value)) {
      throw new Error(`appearance pack ${id} is missing a valid ${role} surface color`);
    }
    ordered[role] = value;
  }
  return Object.freeze({ scheme, id, labelKey, name, surfaces: Object.freeze(ordered) });
}

/**
 * @param {string} lightValue - Value used by the light scheme.
 * @param {string} darkValue - Value used by the dark scheme.
 * @returns {{ light: string, dark: string }} Frozen scheme pair.
 */
function schemePair(lightValue, darkValue) {
  return Object.freeze({ light: lightValue, dark: darkValue });
}

/**
 * @param {string} name - Human-facing pair name.
 * @param {'light'|'dark'} scheme - Palette mode the pair is measured in.
 * @param {string} foreground - Foreground token name, or a literal `#RRGGBB` for fixed glyph colors.
 * @param {string} background - Background token name.
 * @param {number} minimum - Minimum WCAG ratio.
 * @returns {object} Frozen contrast-pair record.
 */
function contrastPair(name, scheme, foreground, background, minimum) {
  return Object.freeze({ name, scheme, foreground, background, minimum });
}

/**
 * Read both scheme values for one token from a palette layer.
 * @param {Record<string, { light: string, dark: string }>} layer - Token layer.
 * @param {string} token - Token name.
 * @returns {{ light: string, dark: string }} The scheme pair.
 */
export function tokenPair(layer, token) {
  const value = layer[token];
  if (value === undefined) throw new Error(`appearance palette is missing token ${token}`);
  return value;
}
