/**
 * Shared visual language for the StudyBuddy plug-in pages.
 *
 * The reference is <https://pi.dev/>: hairline rules, quiet warm panels, mono
 * micro-labels and meta chips, and serif display headings. The palette is not
 * copied from Pi — every colour is a DSH semantic token, so the pages follow the
 * active light/dark scheme and the StudyBuddy appearance packs instead of
 * fighting them. Only the structure (type scale, spacing, radii, surfaces,
 * interaction states) is borrowed.
 *
 * Two layers live here:
 *
 * 1. Style objects the pages pass to `React.createElement`. Inline styles still
 *    carry the layout, but every visual value comes from this module, so a page
 *    never invents its own border, radius, font or colour. The pages also put
 *    `data-study-page` on their root; that attribute is what the stylesheet
 *    below scopes to.
 * 2. One plugin-owned stylesheet (`installStudyStyles`) for the states inline
 *    styles cannot express: hover, focus-visible, disabled, scrollbars,
 *    `prefers-reduced-motion`, and the page shell that makes the main panel
 *    scroll. The page shell rule also fixes the long-standing defect where a
 *    page taller than the frame could not be scrolled: the panel body used to
 *    grow past the frame and be clipped. The stylesheet is installed once by
 *    `study-core`, which every study plug-in depends on.
 *
 * Node tests can import this module without a DOM: nothing touches `document`
 * until {@link installStudyStyles} is called with a real document.
 */

/** DOM id of the injected stylesheet; one study-core instance owns it. */
export const STYLE_ID = 'study-ui-styles';

/** Serif stack for display headings; Pi's editorial voice, CJK-safe. */
export const FONT_SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", SimSun, Georgia, serif';

/** Mono stack for labels, chips, numbers and code. */
export const FONT_MONO = 'var(--ds-font-family-code)';

/** Body text stack; the user's DSH font choice. */
export const FONT_TEXT = 'var(--dsw-font-family)';

/** Primary label colour. */
const TEXT = 'var(--dsw-alias-label-primary)';
/** Secondary label colour. */
const TEXT_SECONDARY = 'var(--dsw-alias-label-secondary)';
/** Tertiary label colour. */
const TEXT_TERTIARY = 'var(--dsw-alias-label-tertiary)';
/** Accent colour supplied by the active appearance pack. */
const ACCENT = 'var(--dsw-alias-brand-primary)';
/** Hairline border between surfaces. */
const LINE = 'var(--dsw-alias-border-l2)';
/** Hairline border on controls and raised surfaces. */
const LINE_STRONG = 'var(--dsw-alias-border-l3)';
/** Panel surface: the theme layer plus a wash of its own text colour. */
const PANEL = 'color-mix(in srgb, var(--dsw-alias-label-primary) 3%, var(--dsw-alias-bg-layer-1))';
/** Flat translucent wash for fields and segmented controls. */
const PANEL_SOFT = 'color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent)';
/** Tinted accent surface for the active choice. */
const ACCENT_SOFT = 'color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent)';
/** Accent border that stays readable on every pack. */
const ACCENT_LINE = 'color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l3))';
/** Danger text. */
const DANGER = 'var(--dsw-alias-state-error-primary)';
/** Warning text. */
const WARN = 'var(--dsw-alias-state-warn-label)';
/** Warning hairline. */
const WARN_LINE = 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent)';
/** Warning surface. */
const WARN_SOFT = 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent)';
/** Danger hairline. */
const DANGER_LINE = 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent)';
/** Danger surface. */
const DANGER_SOFT = 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)';
/** Softer drop shadow than the native popovers use; pages stay flat and quiet. */
const PANEL_SHADOW = '0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent), 0 10px 30px color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent)';

/**
 * Page root: the frame hands the selected main panel a column flex box with a
 * definite height, so the sheet makes the page itself the scroller. The content
 * column is centred by {@link contentStyle}; the root stays a plain scroll
 * container so wheel and trackpad input land on the page rather than the frame.
 */
export const ROOT_STYLE = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  padding: 'clamp(22px, 2.6vw, 38px) clamp(18px, 4vw, 56px) 64px',
  color: TEXT,
  fontSize: '13px',
  lineHeight: 1.55,
};

/**
 * One page's content column.
 * @param {number} [maxWidth] - Reading width in px; defaults to 960.
 * @returns {object} Centred flex column style.
 */
export function contentStyle(maxWidth = 960) {
  return {
    width: '100%',
    maxWidth: `${maxWidth}px`,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
  };
}

/** Page header: title block on the left, actions on the right. */
export const HEADER_STYLE = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '18px',
  flexWrap: 'wrap',
};

/** Page title: serif display, tight leading, regular weight. */
export const TITLE_STYLE = {
  margin: 0,
  fontFamily: FONT_SERIF,
  fontSize: 'clamp(26px, 2.3vw, 33px)',
  fontWeight: 400,
  fontStyle: 'normal',
  letterSpacing: '-0.02em',
  lineHeight: 1.08,
};

/** Page subtitle. */
export const SUBTITLE_STYLE = {
  margin: '9px 0 0',
  fontSize: '13px',
  lineHeight: 1.7,
  color: TEXT_TERTIARY,
  maxWidth: '64ch',
};

/** Row of page-level actions. */
export const TOOLBAR_STYLE = {
  display: 'flex',
  gap: '8px',
  flexWrap: 'wrap',
  alignItems: 'center',
};

/** Alias used by pages that call the header action row `ACTIONS_STYLE`. */
export const ACTIONS_STYLE = TOOLBAR_STYLE;

/**
 * Button: mono micro-label on a hairline control. Hover, focus and disabled
 * states come from the stylesheet because an inline style cannot express them.
 */
export const BUTTON_STYLE = {
  appearance: 'none',
  fontFamily: FONT_MONO,
  fontVariantLigatures: 'none',
  border: `1px solid ${LINE_STRONG}`,
  borderRadius: '3px',
  background: 'transparent',
  color: TEXT_SECONDARY,
  padding: '6px 11px',
  fontSize: '11px',
  letterSpacing: '0.07em',
  lineHeight: 1.25,
  textTransform: 'uppercase',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

/** Button in its selected / pressed state (segmented controls, active tab). */
export const BUTTON_ACTIVE_STYLE = {
  ...BUTTON_STYLE,
  borderColor: ACCENT_LINE,
  background: ACCENT_SOFT,
  color: ACCENT,
};

/** Button that commits the page's main write. */
export const BUTTON_PRIMARY_STYLE = {
  ...BUTTON_STYLE,
  borderColor: ACCENT_LINE,
  background: ACCENT_SOFT,
  color: ACCENT,
};

/** Card: the quiet panel that replaces the old plain wireframe rectangles. */
export const CARD_STYLE = {
  border: `1px solid ${LINE}`,
  borderRadius: '4px',
  padding: '18px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  background: PANEL,
  boxShadow: PANEL_SHADOW,
  boxSizing: 'border-box',
};

/** Card that calls out a risk the student should read before writing. */
export const WARNING_CARD_STYLE = {
  ...CARD_STYLE,
  borderColor: WARN_LINE,
  background: WARN_SOFT,
};

/** Card holding an unconfirmed draft. */
export const DRAFT_CARD_STYLE = {
  ...CARD_STYLE,
  borderStyle: 'dashed',
};

/** Card that alerts on a failed or expired state. */
export const CARD_ALERT_STYLE = {
  ...CARD_STYLE,
  borderColor: DANGER_LINE,
  background: DANGER_SOFT,
};

/** Section heading inside a card: small serif display. */
export const SECTION_HEADING_STYLE = {
  margin: 0,
  fontFamily: FONT_SERIF,
  fontSize: '17.5px',
  fontWeight: 400,
  letterSpacing: '-0.005em',
  lineHeight: 1.25,
};

/** Alias used by pages that name the section heading `SECTION_STYLE`. */
export const SECTION_STYLE = SECTION_HEADING_STYLE;

/** Alias used by pages that name the section heading `SECTION_TITLE_STYLE`. */
export const SECTION_TITLE_STYLE = SECTION_HEADING_STYLE;

/** Mono micro-label for sub-sections and grouped lists. */
export const SUBHEADING_STYLE = {
  margin: 0,
  fontFamily: FONT_MONO,
  fontSize: '10.5px',
  fontWeight: 400,
  letterSpacing: '0.09em',
  lineHeight: 1.5,
  textTransform: 'uppercase',
  color: TEXT_TERTIARY,
};

/** Regular message text. */
export const MESSAGE_STYLE = {
  margin: 0,
  fontSize: '13px',
  lineHeight: 1.7,
  color: TEXT_SECONDARY,
};

/** Error message text. */
export const ERROR_STYLE = {
  ...MESSAGE_STYLE,
  color: DANGER,
};

/** Warning message text. */
export const WARNING_STYLE = {
  ...MESSAGE_STYLE,
  color: WARN,
};

/** Small note below a card's content. */
export const NOTE_STYLE = {
  margin: 0,
  fontSize: '12px',
  lineHeight: 1.7,
  color: TEXT_TERTIARY,
};

/** Alias used by pages that name the small note `RULE_STYLE`. */
export const RULE_STYLE = NOTE_STYLE;

/** Alias used by pages that name the small note `MUTED_STYLE`. */
export const MUTED_STYLE = NOTE_STYLE;

/** Vertical list. */
export const LIST_STYLE = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

/** One hairline-separated row in a list. */
export const ROW_STYLE = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '12px',
  flexWrap: 'wrap',
  padding: '12px 0',
  borderTop: `1px solid ${LINE}`,
};

/** Row meta line: mono, quiet, wraps. */
export const META_STYLE = {
  display: 'flex',
  gap: '10px',
  flexWrap: 'wrap',
  fontFamily: FONT_MONO,
  fontSize: '11px',
  letterSpacing: '0.02em',
  color: TEXT_TERTIARY,
  margin: '4px 0 0',
};

/** Meta chip: Pi's mono uppercase tag. */
export const BADGE_STYLE = {
  border: `1px solid ${LINE_STRONG}`,
  borderRadius: '2px',
  padding: '2px 7px',
  fontFamily: FONT_MONO,
  fontSize: '10.5px',
  letterSpacing: '0.06em',
  lineHeight: 1.4,
  color: TEXT_TERTIARY,
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
};

/** Chip for a state the student has not committed yet. */
export const PENDING_STYLE = {
  ...BADGE_STYLE,
  borderStyle: 'dashed',
};

/** Free-standing body text block. */
export const TEXT_STYLE = {
  margin: '4px 0 0',
  fontSize: '13.5px',
  lineHeight: 1.7,
  wordBreak: 'break-word',
};

/** One labelled form field. */
export const FIELD_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: '5px',
  fontSize: '11px',
  fontFamily: FONT_MONO,
  letterSpacing: '0.03em',
  color: TEXT_TERTIARY,
  minWidth: '150px',
  flex: '1 1 180px',
};

/** A field that shares its row with other fields. */
export const FIELD_ROW_STYLE = {
  ...FIELD_STYLE,
  flex: '1 1 190px',
};

/** Row of form fields. */
export const FIELDS_STYLE = {
  display: 'flex',
  gap: '12px',
  flexWrap: 'wrap',
};

/** Text input, select and textarea. */
export const INPUT_STYLE = {
  padding: '7px 9px',
  fontSize: '13px',
  fontFamily: FONT_TEXT,
  color: TEXT,
  background: PANEL_SOFT,
  border: `1px solid ${LINE_STRONG}`,
  borderRadius: '3px',
  boxSizing: 'border-box',
  width: '100%',
};

/** Two or three summary figures in a row. */
export const SUMMARY_STYLE = {
  display: 'flex',
  gap: '20px',
  flexWrap: 'wrap',
  fontSize: '13px',
};

/** One summary figure. */
export const SUMMARY_BLOCK_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
  minWidth: '150px',
};

/** Caption above a summary figure. */
export const SUMMARY_LABEL_STYLE = {
  fontFamily: FONT_MONO,
  fontSize: '10.5px',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: TEXT_TERTIARY,
};

/** Row of summary figures used by the questions page. */
export const SUMMARY_ROW_STYLE = {
  display: 'flex',
  gap: '16px',
  flexWrap: 'wrap',
  fontSize: '12px',
  color: TEXT_TERTIARY,
};

/** Definition term in a status list: mono micro-label. */
export const TERM_STYLE = {
  margin: 0,
  fontFamily: FONT_MONO,
  fontSize: '11px',
  letterSpacing: '0.03em',
  color: TEXT_TERTIARY,
};

/** Definition value in a status list: mono data line. */
export const VALUE_STYLE = {
  margin: 0,
  wordBreak: 'break-word',
  fontFamily: FONT_MONO,
  fontSize: '12px',
  color: TEXT_SECONDARY,
};

/** Page-owned stylesheet text; scoped to `[data-study-page]`. */
export const STYLE_TEXT = `
[data-study-page] {
  position: relative;
  background-color: var(--dsw-alias-bg-base);
  background-image:
    radial-gradient(1100px 380px at 50% -160px, color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent), transparent 72%),
    radial-gradient(color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent) 0.5px, transparent 0.5px);
  background-size: auto, 22px 22px;
  background-position: center top, center top;
  background-repeat: no-repeat, repeat;
}

[data-study-page] > * {
  flex: none;
}

/* UA block margins make unstyled card copy drift; the card gap owns spacing. */
[data-study-page] :where(p, h1, h2, h3, h4, h5, h6, dl, dt, dd, figure, blockquote) {
  margin-block: 0;
}

[data-study-page] :where(dd) {
  margin-inline-start: 0;
}

/* Pi-style page mark: a short accent rule above the display title. */
[data-study-page] h1::before {
  content: '';
  display: block;
  width: 30px;
  height: 2px;
  margin-bottom: 16px;
  background: var(--dsw-alias-brand-primary);
  opacity: 0.85;
}

/* Pi-style section marker: a short accent rule before each card heading. */
[data-study-page] h2::before {
  content: '';
  display: inline-block;
  width: 16px;
  height: 1px;
  margin-right: 9px;
  vertical-align: 0.3em;
  background: var(--dsw-alias-brand-primary);
  opacity: 0.72;
}

[data-study-page] button {
  transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
}

@media (hover: hover) {
  [data-study-page] button:not(:disabled):hover {
    color: var(--dsw-alias-label-primary);
    border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l3));
    background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent);
  }

  [data-study-page] button:not(:disabled):active {
    background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent);
  }

  [data-study-page] details > summary:hover,
  [data-study-page] a:hover {
    color: var(--dsw-alias-label-primary);
  }
}

[data-study-page] button:focus-visible,
[data-study-page] input:focus-visible,
[data-study-page] select:focus-visible,
[data-study-page] textarea:focus-visible,
[data-study-page] summary:focus-visible,
[data-study-page] a:focus-visible,
[data-study-page] [tabindex]:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 2px;
}

[data-study-page] button:disabled {
  opacity: 0.48;
  cursor: default;
}

[data-study-page] input:focus,
[data-study-page] select:focus,
[data-study-page] textarea:focus {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l3));
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);
}

[data-study-page] input::placeholder,
[data-study-page] textarea::placeholder {
  color: var(--dsw-alias-label-dimmed);
}

[data-study-page] input[type='checkbox'] {
  accent-color: var(--dsw-alias-brand-primary);
  width: 14px;
  height: 14px;
  margin: 0;
  flex: none;
}

[data-study-page] details {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 3px;
  padding: 9px 12px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent);
}

[data-study-page] details[open] {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);
}

[data-study-page] summary {
  cursor: pointer;
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--dsw-alias-label-tertiary);
  list-style-position: outside;
}

[data-study-page] code,
[data-study-page] kbd {
  font-family: var(--ds-font-family-code);
  font-size: 0.92em;
}

[data-study-page] a {
  color: var(--dsw-alias-link, var(--dsw-alias-brand-primary));
  text-decoration: none;
  border-bottom: 1px solid var(--dsw-alias-border-l3);
}

[data-study-page] ::selection {
  background: var(--dsw-alias-bg-document-selection);
  color: var(--dsw-alias-label-primary);
}

[data-study-page] ::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

[data-study-page] ::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1, var(--dsw-alias-border-l3));
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}

[data-study-page] ::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-border-l4));
  background-clip: padding-box;
  border: 2px solid transparent;
}

[data-study-page] ::-webkit-scrollbar-track {
  background: transparent;
}

@media (max-width: 767px) {
  [data-study-page] {
    padding: 18px 16px 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-study-page] button {
    transition: none;
  }
}

@media (forced-colors: active) {
  [data-study-page] {
    background-image: none;
  }

  [data-study-page] h2::before {
    background: CanvasText;
  }
}
`;

/**
 * Install the shared stylesheet once and return its disposer.
 *
 * `document` is read from `globalThis` at call time so Node tests that load the
 * bundle inside a VM context without a DOM can still evaluate the plugin: the
 * call is a no-op there.
 * @param {Document} [doc] - Document to install into; defaults to `globalThis.document`.
 * @returns {() => void} Disposer that removes the element this call created.
 */
export function installStudyStyles(doc = globalThis.document) {
  if (doc === undefined || doc === null || doc.head === undefined) return () => {};
  const existing = doc.getElementById?.(STYLE_ID);
  if (existing !== undefined && existing !== null) return () => {};
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute('data-study-ui', 'stylesheet');
  style.textContent = STYLE_TEXT;
  doc.head.appendChild(style);
  return () => { style.remove?.(); };
}
