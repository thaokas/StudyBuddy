interface PresentationClaim {
  reminderId: string
  claimedAt: number
}

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const STORAGE_KEY = 'studybuddy.reminder.presented'
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function claimStoredReminderPresentation(
  reminderId: string,
  storage: StorageLike,
  now: number = Date.now()
): boolean {
  let stored: PresentationClaim[] = []
  try {
    stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    stored = []
  }

  const recent = stored.filter((claim) => now - claim.claimedAt < CLAIM_TTL_MS)
  if (recent.some((claim) => claim.reminderId === reminderId)) {
    return false
  }
  recent.push({ reminderId, claimedAt: now })
  storage.setItem(STORAGE_KEY, JSON.stringify(recent.slice(-200)))
  return true
}

export async function claimRealtimePresentation(reminderId: string): Promise<boolean> {
  const claim = () => claimStoredReminderPresentation(reminderId, window.localStorage)

  try {
    if ('locks' in navigator && navigator.locks) {
      return await navigator.locks.request(`studybuddy-reminder:${reminderId}`, () => claim())
    }
    return claim()
  } catch {
    return true
  }
}
