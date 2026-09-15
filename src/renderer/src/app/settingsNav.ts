import { isGil } from '@shared/gilMode'
import type { SettingsSection } from '@/store'

// The Settings modal's left nav (1.5). Pulled out of SettingsModal.tsx so it
// can be exercised by the node-only vitest suite without rendering the modal.
//
// Everything here is the same for everyone except Admin, which is listed only
// for an admin — today only Gil (`isGil`, `TEAM_ADMIN_NAMES`). Hiding it is a
// courtesy, not the enforcement: the rename it offers is refused by
// `ChatService.renameTeam` and, more to the point, ignored by every other
// client's fold (main/services/teamSettings.ts).

export function navFor(displayName: string | null | undefined): { id: SettingsSection; label: string }[] {
  return [
    { id: 'profile', label: 'Profile' },
    ...(isGil(displayName) ? [{ id: 'admin' as SettingsSection, label: 'Admin' }] : []),
    { id: 'appearance', label: 'Appearance' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'quickMessages', label: 'Quick messages' },
    { id: 'storage', label: 'Storage & Share' },
    { id: 'about', label: 'About' },
  ]
}
