import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONTRAST_PAIRS,
  DARK_PACKS,
  DEFAULT_DARK_PACK,
  DEFAULT_LIGHT_PACK,
  LIGHT_PACKS,
  SURFACE_ROLES,
  TOKEN_NAMES,
  normalizeDarkPack,
  normalizeLightPack,
  packSwatches,
  tokenLayer,
  tokenPair,
} from '../client/theme.js';

const HEX = /^#[0-9A-Fa-f]{6}$/;
const LIGHT_PACK_IDS = Object.keys(LIGHT_PACKS);
const DARK_PACK_IDS = Object.keys(DARK_PACKS);

/** @param {string} hex - Six-digit hex color. @returns {number[]} sRGB channels. */
function channels(hex) {
  assert.match(hex, HEX, `expected a six-digit hex color, got ${hex}`);
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
}

/** @param {string} hex - Six-digit hex color. @returns {number} WCAG relative luminance. */
function luminance(hex) {
  return channels(hex)
    .map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

/** @param {string} foreground @param {string} background @returns {number} WCAG contrast ratio. */
function contrast(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  const [lighter, darker] = first >= second ? [first, second] : [second, first];
  return (lighter + 0.05) / (darker + 0.05);
}

describe('appearance palette packs', () => {
  it('ships three light packs and three dark packs with ten surfaces each', () => {
    assert.equal(LIGHT_PACK_IDS.length, 3);
    assert.equal(DARK_PACK_IDS.length, 3);
    assert.deepEqual(LIGHT_PACK_IDS, ['sprout-paper', 'mint-mist', 'celadon-page']);
    assert.deepEqual(DARK_PACK_IDS, ['deep-sea', 'midnight-indigo', 'starry-blue']);
    for (const [id, pack] of [...Object.entries(LIGHT_PACKS), ...Object.entries(DARK_PACKS)]) {
      assert.equal(pack.id, id);
      assert.equal(typeof pack.labelKey, 'string');
      assert.equal(pack.labelKey.startsWith('appearance.pack.'), true);
      assert.deepEqual(Object.keys(pack.surfaces), SURFACE_ROLES);
      for (const role of SURFACE_ROLES) assert.match(pack.surfaces[role], HEX, `${id} ${role}`);
    }
    assert.equal(DEFAULT_LIGHT_PACK, 'sprout-paper');
    assert.equal(DEFAULT_DARK_PACK, 'deep-sea');
  });

  it('ships both scheme values for every token in every light × dark pack pair', () => {
    assert.ok(TOKEN_NAMES.length >= 60, 'the layer should cover the surface, text, state, markdown and control tokens');
    assert.ok(TOKEN_NAMES.includes('--study-topbar'), 'the top-bar surface is a plugin-owned token');
    for (const lightPack of LIGHT_PACK_IDS) {
      for (const darkPack of DARK_PACK_IDS) {
        const layer = tokenLayer(lightPack, darkPack);
        assert.equal(Object.keys(layer).length, TOKEN_NAMES.length);
        for (const name of TOKEN_NAMES) {
          const pair = tokenPair(layer, name);
          assert.equal(typeof pair.light, 'string', `${lightPack}/${darkPack} ${name} light`);
          assert.equal(typeof pair.dark, 'string', `${lightPack}/${darkPack} ${name} dark`);
          assert.match(pair.light, HEX, `${lightPack}/${darkPack} ${name} light`);
          assert.match(pair.dark, HEX, `${lightPack}/${darkPack} ${name} dark`);
        }
      }
    }
  });

  it('draws light values from the light pack and dark values from the dark pack', () => {
    const layer = tokenLayer('mint-mist', 'starry-blue');
    assert.deepEqual(layer['--dsw-alias-bg-base'], {
      light: LIGHT_PACKS['mint-mist'].surfaces.base,
      dark: DARK_PACKS['starry-blue'].surfaces.base,
    });
    assert.deepEqual(layer['--dsw-specific-sidebar-fill'], {
      light: LIGHT_PACKS['mint-mist'].surfaces.sidebar,
      dark: DARK_PACKS['starry-blue'].surfaces.sidebar,
    });
    assert.deepEqual(layer['--study-topbar'], {
      light: LIGHT_PACKS['mint-mist'].surfaces.topbar,
      dark: DARK_PACKS['starry-blue'].surfaces.topbar,
    });
    const layer2 = tokenLayer('celadon-page', 'midnight-indigo');
    assert.equal(layer2['--dsw-alias-bg-layer-2'].light, LIGHT_PACKS['celadon-page'].surfaces.layer2);
    assert.equal(layer2['--dsw-alias-bg-layer-2'].dark, DARK_PACKS['midnight-indigo'].surfaces.layer2);
    assert.equal(layer2['--dsw-specific-input-major'].light, LIGHT_PACKS['celadon-page'].surfaces.input);
    assert.equal(layer2['--dsw-specific-bubble'].dark, DARK_PACKS['midnight-indigo'].surfaces.bubble);
  });

  it('paints the send button and DSH signal accent from the family, not the light accent', () => {
    const layer = tokenLayer('celadon-page', 'starry-blue');
    assert.deepEqual(layer['--dsw-alias-button-info-fill'], { light: '#3F6B26', dark: '#4E7FD8' });
    assert.deepEqual(layer['--dsw-alias-button-info-hover'], { light: '#35591F', dark: '#3F6FC4' });
    assert.deepEqual(layer['--dsw-alias-brand-primary-new-colorprimary-new-color'], { light: '#3F6B26', dark: '#4E7FD8' });
    assert.equal(Object.keys(layer).length, TOKEN_NAMES.length);
    // The dark fixed-white send glyph needs a background-only fill; the lifted
    // readable accent would drop the white arrow to roughly 2.1:1.
    assert.notEqual(layer['--dsw-alias-button-info-fill'].dark, layer['--dsw-alias-brand-primary'].dark);
  });

  it('keeps each pack distinguishable on the three student-facing surfaces', () => {
    for (const surfaces of [LIGHT_PACKS, DARK_PACKS]) {
      const packs = Object.values(surfaces);
      for (const role of ['base', 'sidebar', 'topbar']) {
        assert.equal(new Set(packs.map(pack => pack.surfaces[role])).size, 3, `${role} must differ across packs`);
      }
    }
    assert.notDeepEqual(tokenLayer('sprout-paper', 'deep-sea'), tokenLayer('mint-mist', 'deep-sea'));
    assert.notDeepEqual(tokenLayer('sprout-paper', 'deep-sea'), tokenLayer('sprout-paper', 'midnight-indigo'));
  });

  it('returns an empty layer when disabled so the native palette wins', () => {
    assert.deepEqual(tokenLayer(undefined, undefined, false), {});
    assert.deepEqual(tokenLayer('mint-mist', 'starry-blue', false), {});
  });

  it('normalizes unknown or wrong-family pack ids to the defaults', () => {
    assert.equal(normalizeLightPack('celadon-page'), 'celadon-page');
    assert.equal(normalizeLightPack('deep-sea'), DEFAULT_LIGHT_PACK);
    assert.equal(normalizeLightPack('unknown'), DEFAULT_LIGHT_PACK);
    assert.equal(normalizeLightPack(undefined), DEFAULT_LIGHT_PACK);
    assert.equal(normalizeLightPack(''), DEFAULT_LIGHT_PACK);
    assert.equal(normalizeDarkPack('starry-blue'), 'starry-blue');
    assert.equal(normalizeDarkPack('sprout-paper'), DEFAULT_DARK_PACK);
    assert.equal(normalizeDarkPack('unknown'), DEFAULT_DARK_PACK);
    assert.equal(normalizeDarkPack(undefined), DEFAULT_DARK_PACK);
    assert.equal(tokenLayer('unknown', 'unknown')['--dsw-alias-bg-base'].light, LIGHT_PACKS[DEFAULT_LIGHT_PACK].surfaces.base);
    assert.equal(tokenLayer('unknown', 'unknown')['--dsw-alias-bg-base'].dark, DARK_PACKS[DEFAULT_DARK_PACK].surfaces.base);
  });

  it('exposes the sidebar, canvas and top-bar swatches of a pack for the settings row', () => {
    assert.deepEqual(packSwatches('sprout-paper'), {
      sidebar: LIGHT_PACKS['sprout-paper'].surfaces.sidebar,
      base: LIGHT_PACKS['sprout-paper'].surfaces.base,
      topbar: LIGHT_PACKS['sprout-paper'].surfaces.topbar,
    });
    assert.deepEqual(packSwatches('starry-blue'), {
      sidebar: DARK_PACKS['starry-blue'].surfaces.sidebar,
      base: DARK_PACKS['starry-blue'].surfaces.base,
      topbar: DARK_PACKS['starry-blue'].surfaces.topbar,
    });
    assert.deepEqual(packSwatches('unknown'), {
      sidebar: LIGHT_PACKS[DEFAULT_LIGHT_PACK].surfaces.sidebar,
      base: LIGHT_PACKS[DEFAULT_LIGHT_PACK].surfaces.base,
      topbar: LIGHT_PACKS[DEFAULT_LIGHT_PACK].surfaces.topbar,
    });
  });

  it('throws when a token pair is unknown', () => {
    assert.throws(() => tokenPair({}, '--dsw-alias-bg-base'), /missing token/);
  });
});

describe('appearance palette contrast', () => {
  /**
   * Read one side of a contrast pair. A foreground may be a literal hex for
   * glyphs DSH paints in a fixed color (the send arrow is static #fff).
   * @param {object} layer - Token layer.
   * @param {string} name - Token name or literal `#RRGGBB`.
   * @param {'light'|'dark'} scheme - Active scheme.
   * @returns {string} Hex color value.
   */
  function value(layer, name, scheme) {
    return name.startsWith('#') ? name : tokenPair(layer, name)[scheme];
  }

  for (const lightPack of LIGHT_PACK_IDS) {
    for (const entry of CONTRAST_PAIRS.filter(item => item.scheme === 'light')) {
      it(`light/${lightPack}: ${entry.name} meets ${entry.minimum}:1`, () => {
        const layer = tokenLayer(lightPack, DEFAULT_DARK_PACK);
        const foreground = value(layer, entry.foreground, 'light');
        const background = value(layer, entry.background, 'light');
        const ratio = contrast(foreground, background);
        assert.ok(ratio >= entry.minimum, `${entry.name} is ${ratio.toFixed(2)}:1 (need ${entry.minimum}:1)`);
      });
    }
  }
  for (const darkPack of DARK_PACK_IDS) {
    for (const entry of CONTRAST_PAIRS.filter(item => item.scheme === 'dark')) {
      it(`dark/${darkPack}: ${entry.name} meets ${entry.minimum}:1`, () => {
        const layer = tokenLayer(DEFAULT_LIGHT_PACK, darkPack);
        const foreground = value(layer, entry.foreground, 'dark');
        const background = value(layer, entry.background, 'dark');
        const ratio = contrast(foreground, background);
        assert.ok(ratio >= entry.minimum, `${entry.name} is ${ratio.toFixed(2)}:1 (need ${entry.minimum}:1)`);
      });
    }
  }
});
