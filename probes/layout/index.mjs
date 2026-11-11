/**
 * T03 probe host row.
 *
 * The probe has no host behaviour: all observations live in the client bundle
 * (`client.js`), which registers a wide right-Sidebar tab and, when the
 * third-party `dock-base` workbench is present, a workbench panel/view. The row
 * exists only so the Loader mounts the package and the client module registry
 * picks up `package.json` → `exports["./client"]`.
 */

/** Plugin name reported by the DSH loader. */
export const name = 'layout-probe';

/** No host services are needed for the layout probe. */
export function apply() {}
