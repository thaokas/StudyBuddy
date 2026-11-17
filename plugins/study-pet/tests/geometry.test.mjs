import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASE_HEIGHT,
  BASE_WIDTH,
  EDGE_MARGIN,
  clampPosition,
  defaultPosition,
  dragTo,
  petBox,
  resolvePosition,
} from '../client/geometry.js';

const VIEWPORT = { viewportWidth: 1440, viewportHeight: 900 };

describe('pet geometry', () => {
  it('scales the base figure at the three supported sizes', () => {
    assert.deepEqual(petBox(1), { width: BASE_WIDTH, height: BASE_HEIGHT });
    assert.deepEqual(petBox(0.85), { width: Math.round(BASE_WIDTH * 0.85), height: Math.round(BASE_HEIGHT * 0.85) });
    assert.deepEqual(petBox(1.2), { width: Math.round(BASE_WIDTH * 1.2), height: Math.round(BASE_HEIGHT * 1.2) });
    assert.deepEqual(petBox(Number.NaN), { width: BASE_WIDTH, height: BASE_HEIGHT });
    assert.deepEqual(petBox(-2), { width: BASE_WIDTH, height: BASE_HEIGHT });
  });

  it('clamps a position so the whole box stays inside the viewport', () => {
    const box = { width: BASE_WIDTH, height: BASE_HEIGHT, ...VIEWPORT };
    assert.deepEqual(clampPosition({ left: -100, top: -100, ...box }), { left: EDGE_MARGIN, top: EDGE_MARGIN });
    assert.deepEqual(clampPosition({ left: 99_999, top: 99_999, ...box }), {
      left: 1440 - BASE_WIDTH - EDGE_MARGIN,
      top: 900 - BASE_HEIGHT - EDGE_MARGIN,
    });
    assert.deepEqual(clampPosition({ left: 500, top: 300, ...box }), { left: 500, top: 300 });
  });

  it('keeps a margin on a viewport smaller than the pet', () => {
    const box = { width: BASE_WIDTH, height: BASE_HEIGHT, viewportWidth: 100, viewportHeight: 100 };
    assert.deepEqual(clampPosition({ left: 50, top: 50, ...box }), { left: EDGE_MARGIN, top: EDGE_MARGIN });
  });

  it('rests at the bottom right by default', () => {
    assert.deepEqual(defaultPosition({ width: BASE_WIDTH, height: BASE_HEIGHT, ...VIEWPORT }), {
      left: 1440 - BASE_WIDTH - EDGE_MARGIN,
      top: 900 - BASE_HEIGHT - EDGE_MARGIN,
    });
  });

  it('resolves a remembered position and clamps it after a resize', () => {
    const box = { width: BASE_WIDTH, height: BASE_HEIGHT, ...VIEWPORT };
    const stored = { left: 1200, top: 100 };
    assert.deepEqual(resolvePosition({ position: stored, ...box }), stored);

    const narrow = resolvePosition({
      position: stored,
      width: BASE_WIDTH,
      height: BASE_HEIGHT,
      viewportWidth: 800,
      viewportHeight: 600,
    });
    assert.equal(narrow.left, 800 - BASE_WIDTH - EDGE_MARGIN);
    assert.equal(narrow.top, 100);

    assert.deepEqual(resolvePosition({ position: null, ...box }), defaultPosition({
      width: BASE_WIDTH, height: BASE_HEIGHT, ...VIEWPORT,
    }));
  });

  it('drags by a clamped delta', () => {
    const box = { width: BASE_WIDTH, height: BASE_HEIGHT, ...VIEWPORT };
    const start = { left: 600, top: 300 };
    assert.deepEqual(dragTo(start, 120, 60, box), { left: 720, top: 360 });
    const clamped = dragTo(start, 10_000, -10_000, box);
    assert.equal(clamped.left, 1440 - BASE_WIDTH - EDGE_MARGIN);
    assert.equal(clamped.top, EDGE_MARGIN);
  });
});
