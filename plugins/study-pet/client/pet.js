/**
 * The `shell.overlay` floating pet component.
 *
 * The component is pure presentation around three pure modules: the scene
 * machine (`state-machine.js`), the bubble scheduler (`bubble.js`), and the
 * persisted preferences (`store.js`). It reads live facts through the standard
 * slot hooks (`useSessionStatus`, plus the registration's `hooks` compartment
 * for the store and locale), renders the user-selected plush "小搭" image, and
 * keeps `data-state` for future pose work. JavaScript never animates pixels
 * except while dragging.
 *
 * `shell.overlay` is `position:absolute; inset:0; pointer-events:none` with
 * interactive children restored to `pointer-events:auto`, so the root is a
 * fixed 150×170 box and only the button/panel/summon control take pointers.
 * The image mirrors horizontally whenever the pet sits on the right half of
 * the viewport, so it always faces into the page.
 */
import { createElement as h, useEffect, useRef, useState } from 'react';
import { createBubbleController, voiceForLocale } from './bubble.js';
import { dragTo, petBox, resolvePosition } from './geometry.js';
import { VOICE } from './lines.js';
import { createPetState, reducePetState } from './state-machine.js';
import { mergeVoicePack } from './voice-pack.js';
import PET_LOGO_URL from './assets/logo1.png';

/** How often the scene machine and bubble scheduler run. */
const FRAME_MS = 1_000;
/** Optional StudyBuddy timer poll interval. */
const TIMER_POLL_MS = 20_000;
/** Pointer travel that turns a click into a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Height above which the bubble/panel flip below the pet. */
const FLIP_TOP_PX = 210;
/** Left edge below which the hover panel opens to the right. */
const PANEL_SIDE_PX = 220;
/** How long the double-click bounce stays on. */
const HAPPY_MS = 1_100;
/** How long the click squash stays on. */
const SQUASH_MS = 280;
/** Delay before the first greeting so the shell has painted. */
const GREET_DELAY_MS = 700;

/**
 * Read the current viewport size.
 * @returns {{ width: number, height: number }} Viewport size in CSS pixels.
 */
function viewportSize() {
  const width = typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 1440;
  const height = typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 900;
  return { width, height };
}

/**
 * Static pet image for 「小搭」.
 *
 * The user asked for the finished fluffy pear-buddy illustration
 * (`assets/logo1.png`, 451×423 RGBA: cream plush, leaf cap, green backpack
 * strap, and notebook) while pose animations are deferred. The image is
 * decorative: the wrapping button carries the accessible name. `object-fit:
 * contain` fits it into the 150×170 box; the mirror wrapper flips only the
 * image when the pet sits on the right half of the viewport.
 * @returns {object} Image element.
 */
function PetPhoto() {
  return h('img', {
    className: 'sp-figure sp-photo',
    src: PET_LOGO_URL,
    alt: '',
    'aria-hidden': 'true',
    draggable: false,
    decoding: 'async',
    'data-study-pet-photo': '',
  });
}

/**
 * Floating pet registration for `shell.overlay`.
 * @param {object} props - Slot props: localized `t`, framework standard hooks,
 *   and the registration's inject face.
 * @returns {object | null} Pet overlay, the summon button while hidden, or nothing.
 */
export function PetOverlay({
  t, usePet, useLocale, useSessionStatus, readVoice, pollTimer, actions,
}) {
  const prefs = typeof usePet === 'function'
    ? usePet(snapshot => snapshot)
    : { enabled: true, chatter: true, size: '1', position: null };
  const active = typeof useLocale === 'function' ? useLocale(snapshot => snapshot.active) : 'zh';
  const sessionStatus = typeof useSessionStatus === 'function'
    ? useSessionStatus(snapshot => snapshot)
    : null;

  const [voice] = useState(() => {
    let pack = null;
    try {
      pack = typeof readVoice === 'function' ? readVoice() : null;
    } catch {
      pack = null;
    }
    return mergeVoicePack(VOICE, pack);
  });
  const [viewport, setViewport] = useState(viewportSize);
  const [scene, setScene] = useState('idle');
  const [bubble, setBubble] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [dragPosition, setDragPosition] = useState(null);
  const [happy, setHappy] = useState(false);
  const [squash, setSquash] = useState(false);

  const machineRef = useRef(null);
  if (machineRef.current === null) machineRef.current = createPetState(Date.now());
  const controllerRef = useRef(null);
  if (controllerRef.current === null) {
    controllerRef.current = createBubbleController({ voice: voiceForLocale(voice, active) });
    controllerRef.current.setChatterEnabled(prefs.chatter === true);
  }
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const activeRef = useRef(active);
  activeRef.current = active;
  const pollTimerRef = useRef(pollTimer);
  pollTimerRef.current = pollTimer;
  const happyTimerRef = useRef(null);
  const squashTimerRef = useRef(null);
  const pointerRef = useRef(null);
  const windowListenersRef = useRef(null);
  const dragPositionRef = useRef(null);
  const suppressClickRef = useRef(false);
  const applyEventRef = useRef(() => {});

  const scale = Number(prefs.size);
  const box = petBox(Number.isFinite(scale) && scale > 0 ? scale : 1);
  const position = dragPosition ?? resolvePosition({
    position: prefs.position,
    width: box.width,
    height: box.height,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  });
  const flip = position.top < FLIP_TOP_PX;
  const panelSide = position.left < PANEL_SIDE_PX ? 'right' : 'left';
  // The plush image faces right by default; mirror it on the right half of the
  // viewport so it faces into the page. The wrapper flips only the image.
  const mirrored = position.left + box.width / 2 > viewport.width / 2;

  /**
   * Run one machine event, then let the controller render its speech effects.
   * @param {object} event - Machine event.
   */
  function applyEvent(event) {
    const { state, effects } = reducePetState(machineRef.current, event);
    const at = Number.isFinite(event?.at) ? event.at : state.since;
    machineRef.current = state;
    controllerRef.current.enterScene(state.scene, at, { speak: false });
    for (const effect of effects) {
      if (effect.type !== 'speak') continue;
      controllerRef.current.say(effect.scene, at, { kind: effect.kind, force: effect.force });
    }
    setScene(state.scene);
    setBubble(controllerRef.current.current());
  }
  applyEventRef.current = applyEvent;

  /**
   * Speak one gesture line unless the pet just woke up (the greet wins).
   * @param {string} actorScene - Gesture scene key.
   * @param {'gesture' | 'chatter'} kind - Bubble kind.
   */
  function gesture(actorScene, kind) {
    const at = Date.now();
    const wasSleeping = machineRef.current.scene === 'sleep';
    applyEvent({ type: 'interact', at });
    if (wasSleeping) return;
    const spoken = controllerRef.current.say(actorScene, at, { kind, force: true });
    if (spoken !== null) setBubble(spoken);
  }

  useEffect(() => {
    const greet = controllerRef.current.say('greet', Date.now(), { kind: 'gesture', force: true });
    if (greet !== null) setBubble(greet);
    const frame = setInterval(() => {
      const at = Date.now();
      applyEventRef.current({ type: 'tick', at });
      controllerRef.current.tick(at);
      setBubble(controllerRef.current.current());
    }, FRAME_MS);
    const onResize = () => {
      setDragPosition(null);
      dragPositionRef.current = null;
      setViewport(viewportSize());
    };
    globalThis.addEventListener?.('resize', onResize);
    return () => {
      clearInterval(frame);
      globalThis.removeEventListener?.('resize', onResize);
      detachWindowDrag();
      if (happyTimerRef.current !== null) clearTimeout(happyTimerRef.current);
      if (squashTimerRef.current !== null) clearTimeout(squashTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (sessionStatus === null) return;
    applyEventRef.current({ type: 'sessions', sessions: sessionStatus, at: Date.now() });
  }, [sessionStatus]);

  useEffect(() => {
    controllerRef.current.setVoice(voiceForLocale(voiceRef.current, active));
  }, [active]);

  useEffect(() => {
    controllerRef.current.setChatterEnabled(prefs.chatter === true);
  }, [prefs.chatter]);

  useEffect(() => {
    const poll = pollTimerRef.current;
    if (typeof poll !== 'function') return undefined;
    let cancelled = false;
    let timer = null;
    const run = async () => {
      let value = null;
      try {
        value = await poll();
      } catch {
        return;
      }
      if (cancelled || value === null || value === undefined) return;
      applyEventRef.current({ type: 'timer', timer: value, at: Date.now() });
    };
    void run();
    timer = setInterval(run, TIMER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /** Remove the window-level drag listeners, if any are installed. */
  function detachWindowDrag() {
    const listeners = windowListenersRef.current;
    if (listeners === null) return;
    globalThis.removeEventListener?.('pointermove', listeners.move);
    globalThis.removeEventListener?.('pointerup', listeners.up);
    globalThis.removeEventListener?.('pointercancel', listeners.up);
    windowListenersRef.current = null;
  }

  /**
   * Start a possible drag or click.
   *
   * Move/up listeners attach to `window` for the duration of the gesture rather
   * than riding only the button's synthetic handlers: the pointer can leave the
   * small pet, and a React re-render must not be able to strand a drag.
   * @param {object} event - Pointer event.
   */
  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const captureTarget = event.currentTarget;
    try {
      captureTarget?.setPointerCapture?.(event.pointerId);
    } catch { /* pointer capture is an enhancement; window listeners still track */ }
    detachWindowDrag();
    const move = next => { onPointerMove(next); };
    const up = next => { finishDrag(next); };
    globalThis.addEventListener?.('pointermove', move);
    globalThis.addEventListener?.('pointerup', up);
    globalThis.addEventListener?.('pointercancel', up);
    windowListenersRef.current = { move, up };
    pointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: position,
      moved: false,
      captureTarget,
    };
    applyEvent({ type: 'interact', at: Date.now() });
  }

  /**
   * Move the pet while a pointer drag is in progress.
   * @param {object} event - Pointer event.
   */
  function onPointerMove(event) {
    const pointer = pointerRef.current;
    if (pointer === null) return;
    if (event.pointerId !== undefined && event.pointerId !== pointer.pointerId) return;
    const dx = event.clientX - pointer.startX;
    const dy = event.clientY - pointer.startY;
    if (!pointer.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      pointer.moved = true;
      setDragging(true);
      applyEvent({ type: 'dragging', value: true, at: Date.now() });
    }
    const next = dragTo(pointer.base, dx, dy, {
      width: box.width,
      height: box.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    });
    dragPositionRef.current = next;
    setDragPosition(next);
  }

  /**
   * Finish a drag, persisting the clamped position; a plain tap stays a click.
   * @param {object} [event] - Pointer event, when available.
   */
  function finishDrag(event) {
    const pointer = pointerRef.current;
    if (pointer === null) return;
    pointerRef.current = null;
    detachWindowDrag();
    try {
      pointer.captureTarget?.releasePointerCapture?.(pointer.pointerId);
    } catch { /* the browser already released it */ }
    if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
    if (pointer.moved) {
      suppressClickRef.current = true;
      const finalPosition = dragPositionRef.current ?? pointer.base;
      actions.setPosition(finalPosition);
      dragPositionRef.current = null;
      setDragPosition(null);
    }
    setDragging(false);
    applyEvent({ type: 'dragging', value: false, at: Date.now() });
  }

  /** Play the brief click squash on the plush image. */
  function squashPet() {
    setSquash(true);
    if (squashTimerRef.current !== null) clearTimeout(squashTimerRef.current);
    squashTimerRef.current = setTimeout(() => {
      squashTimerRef.current = null;
      setSquash(false);
    }, SQUASH_MS);
  }

  /** A click replies with one gesture line; a sleeping pet wakes and greets instead. */
  function onClick() {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    squashPet();
    gesture('click', 'gesture');
  }

  /** Double click: a short happy bounce plus one more reply. */
  function onDoubleClick() {
    if (suppressClickRef.current) return;
    setHappy(true);
    if (happyTimerRef.current !== null) clearTimeout(happyTimerRef.current);
    happyTimerRef.current = setTimeout(() => {
      happyTimerRef.current = null;
      setHappy(false);
    }, HAPPY_MS);
    gesture('click', 'gesture');
  }

  /** Hide the pet; the settings-row switch and the summon button can bring it back. */
  function hidePet() {
    actions.setEnabled(false);
  }

  /** Pat reply. */
  function patPet() {
    gesture('pat', 'gesture');
  }

  /** One immediate inner thought. */
  function chatterNow() {
    gesture('chatter', 'chatter');
  }

  /** Summon the hidden pet and greet. */
  function summon() {
    actions.setEnabled(true);
    const at = Date.now();
    applyEvent({ type: 'wake', at });
    const spoken = controllerRef.current.say('greet', at, { kind: 'gesture', force: true });
    if (spoken !== null) setBubble(spoken);
  }

  if (prefs.enabled !== true) {
    return h('button', {
      type: 'button',
      'data-study-pet-summon': '',
      'aria-label': t('pet.action.summon'),
      title: t('pet.action.summon'),
      onClick: summon,
    }, '🍃');
  }

  const bubbleNode = bubble === null ? null : h('div', {
    className: 'sp-bubble',
    'data-study-pet-bubble': '',
    'data-kind': bubble.kind,
    'data-scene': bubble.scene,
    role: 'status',
    'aria-live': 'polite',
    'aria-label': t('pet.bubble.label'),
  }, bubble.text);

  const panel = h('div', {
    className: 'sp-panel',
    'data-study-pet-panel': '',
    role: 'group',
    'aria-label': t('pet.panel.label'),
  },
  h('button', { type: 'button', 'data-study-pet-hide': '', onClick: hidePet }, t('pet.action.hide')),
  h('button', { type: 'button', 'data-study-pet-pat': '', onClick: patPet }, t('pet.action.pat')),
  h('button', { type: 'button', 'data-study-pet-chatter-now': '', onClick: chatterNow }, t('pet.action.chatter')));

  return h('div', {
    'data-study-pet': '',
    'data-state': scene,
    'data-dragging': dragging ? 'true' : undefined,
    'data-flip': flip ? 'true' : undefined,
    'data-side': panelSide,
    'data-mirror': mirrored ? 'true' : undefined,
    'data-happy': happy ? 'true' : undefined,
    'data-squash': squash ? 'true' : undefined,
    style: {
      left: `${position.left}px`,
      top: `${position.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    },
  },
  bubbleNode,
  panel,
  h('button', {
    type: 'button',
    className: 'sp-button',
    'data-study-pet-body': '',
    'aria-label': t('pet.alt'),
    draggable: false,
    onClick,
    onDoubleClick,
    onPointerDown,
    onDragStart: event => event.preventDefault(),
  }, h('span', { className: 'sp-photo-frame', 'aria-hidden': 'true' }, h(PetPhoto))));
}
