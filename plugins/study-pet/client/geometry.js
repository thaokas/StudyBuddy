/**
 * Viewport geometry for the floating pet.
 *
 * The pet is positioned with `left`/`top` pixels inside the shell overlay.
 * The store keeps the last dragged position; rendering clamps it against the
 * current viewport, so a window resize can never push the pet off screen. All
 * functions here are pure and return new objects.
 */

/** Scale of the base pet figure. */
export const BASE_WIDTH = 150;
/** Height of the base pet box, matching the 150×170 image container. */
export const BASE_HEIGHT = 170;
/** Smallest gap kept between the pet and the viewport edge. */
export const EDGE_MARGIN = 12;

/**
 * Box occupied by one scaled pet figure.
 * @param {number} [scale] - Scale multiplier.
 * @returns {{ width: number, height: number }} Rounded box size.
 */
export function petBox(scale = 1) {
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { width: Math.round(BASE_WIDTH * safe), height: Math.round(BASE_HEIGHT * safe) };
}

/**
 * Clamp one position so the whole box stays inside the viewport.
 * @param {{ left: number, top: number, width: number, height: number,
 *   viewportWidth: number, viewportHeight: number, margin?: number }} input - Candidate geometry.
 * @returns {{ left: number, top: number }} Rounded, in-bounds position.
 */
export function clampPosition({
  left, top, width, height, viewportWidth, viewportHeight, margin = EDGE_MARGIN,
}) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : BASE_WIDTH;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : BASE_HEIGHT;
  const vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : safeWidth + margin * 2;
  const vh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : safeHeight + margin * 2;
  const maxLeft = Math.max(margin, vw - safeWidth - margin);
  const maxTop = Math.max(margin, vh - safeHeight - margin);
  const safeLeft = Number.isFinite(left) ? left : maxLeft;
  const safeTop = Number.isFinite(top) ? top : maxTop;
  return {
    left: Math.round(Math.min(Math.max(safeLeft, margin), maxLeft)),
    top: Math.round(Math.min(Math.max(safeTop, margin), maxTop)),
  };
}

/**
 * Bottom-right resting position for the current viewport.
 * @param {{ width: number, height: number, viewportWidth: number, viewportHeight: number, margin?: number }} input - Box and viewport geometry.
 * @returns {{ left: number, top: number }} Position.
 */
export function defaultPosition({ width, height, viewportWidth, viewportHeight, margin = EDGE_MARGIN }) {
  return clampPosition({
    left: viewportWidth - width - margin,
    top: viewportHeight - height - margin,
    width,
    height,
    viewportWidth,
    viewportHeight,
    margin,
  });
}

/**
 * Resolve the pet's on-screen position: a remembered position clamped to this
 * viewport, or the bottom-right resting position when none was stored.
 * @param {{ position?: { left: number, top: number } | null, width: number, height: number,
 *   viewportWidth: number, viewportHeight: number, margin?: number }} input - Inputs.
 * @returns {{ left: number, top: number }} Position to render.
 */
export function resolvePosition({
  position, width, height, viewportWidth, viewportHeight, margin = EDGE_MARGIN,
}) {
  if (position === undefined || position === null) {
    return defaultPosition({ width, height, viewportWidth, viewportHeight, margin });
  }
  return clampPosition({
    left: position.left,
    top: position.top,
    width,
    height,
    viewportWidth,
    viewportHeight,
    margin,
  });
}

/**
 * Offset one position by a drag delta and clamp it to the viewport.
 * @param {{ left: number, top: number }} start - Pointer-down position.
 * @param {number} dx - Horizontal delta.
 * @param {number} dy - Vertical delta.
 * @param {{ width: number, height: number, viewportWidth: number, viewportHeight: number, margin?: number }} box - Box and viewport.
 * @returns {{ left: number, top: number }} Dragged position.
 */
export function dragTo(start, dx, dy, box) {
  return clampPosition({
    left: start.left + dx,
    top: start.top + dy,
    width: box.width,
    height: box.height,
    viewportWidth: box.viewportWidth,
    viewportHeight: box.viewportHeight,
    margin: box.margin ?? EDGE_MARGIN,
  });
}
