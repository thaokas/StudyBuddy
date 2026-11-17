/**
 * StudyBuddy appearance plugin, node half.
 *
 * The package contributes browser presentation only. This host row exists so
 * the DSH Loader can compose the plugin; the browser half ships through
 * `exports["./client"]` and registers theme tokens, brand slots, and the
 * appearance settings row.
 */

/** Plugin name reported by the DSH Loader. */
export const name = 'study-appearance';

/** Host plugin body: this package contributes browser presentation only. */
export function apply() {}
