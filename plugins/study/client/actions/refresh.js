/**
 * Refresh action for the `today` page: re-reads `kernel.status` instead of
 * reloading the window. Added as its own module so later pages keep their
 * buttons without editing this one.
 */
export default {
  id: 'refresh-today',
  page: 'today',
  label: 'today.refresh',
  run: ({ reload }) => reload(),
};
