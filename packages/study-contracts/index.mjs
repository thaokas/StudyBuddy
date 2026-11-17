/** Service namespaces that may own methods; frozen so modules cannot invent APIs. */
export const NAMESPACES = Object.freeze([
  'kernel',
  'tasks',
  'materials',
  'plans',
  'planning',
  'tutoring',
  'timer',
  'followup',
  'outcomes',
  'milestones',
  'memory',
  'learning',
  'review',
]);

/** Failure codes exposed to clients and tools. */
export const ERROR_CODES = Object.freeze(['invalid', 'conflict', 'not_found', 'unavailable']);

const ERROR_CODE_SET = new Set(ERROR_CODES);

/** A study service failure carrying one of {@link ERROR_CODES}. */
export class StudyError extends Error {
  /**
   * @param {'invalid' | 'conflict' | 'not_found' | 'unavailable'} code - Failure category.
   * @param {string} message - Actionable, user-safe explanation.
   * @param {object} [details] - Machine-readable context; never credentials.
   */
  constructor(code, message, details = {}) {
    if (!ERROR_CODE_SET.has(code)) throw new TypeError(`unknown study error code ${JSON.stringify(code)}`);
    if (typeof message !== 'string' || message.length === 0) {
      throw new TypeError('study error message must be a non-empty string');
    }
    super(message);
    this.name = 'StudyError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Whether a value is a lossless JSON object (not an array, class instance, or null).
 * @param {unknown} value - Candidate value.
 * @returns {boolean} True for `{}` and null-prototype objects.
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}


export function localDate(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}



/** Executor IDs survive tool retries; callers can supply a business ID across calls. */
export function toolRequestId(args, exec) {
  const id = args.requestId ?? exec.callId;
  if (typeof id !== 'string' || !id.trim()) throw new StudyError('invalid', '缺少 requestId（或执行器 callId）；请为同一次操作复用稳定 ID');
  return id;
}
