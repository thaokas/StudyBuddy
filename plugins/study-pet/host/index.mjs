/**
 * StudyBuddy pet plugin, node half.
 *
 * The package contributes browser presentation only: the pet overlay and the
 * General settings row ship through `exports["./client"]`. The host row exists
 * so the DSH Loader can compose the plugin.
 */

/** Plugin name reported by the DSH Loader. */
export const name = 'study-pet';

/** Host plugin body: this package contributes browser presentation only. */
export function apply() {}
