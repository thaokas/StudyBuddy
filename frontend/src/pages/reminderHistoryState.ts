export function toggleExpandedReminderIds(
  expandedReminderIds: ReadonlySet<string>,
  reminderId: string
): Set<string> {
  const next = new Set(expandedReminderIds)

  if (next.has(reminderId)) {
    next.delete(reminderId)
  } else {
    next.add(reminderId)
  }

  return next
}

export function removeReminderFromHistory<T extends { reminderId: string }>(
  history: readonly T[],
  reminderId: string
): T[] {
  return history.filter((item) => item.reminderId !== reminderId)
}
