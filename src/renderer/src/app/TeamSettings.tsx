import { useEffect, useRef, useState } from 'react'
import { TEAM_NAME_MAX, isValidTeamName, normalizeTeamName } from '@shared/teamName'
import { useStore, selfOf } from '@/store'
import { teamRenameFailureNotice, teamRenameSaveNotice } from '@/store/teamRename'
import { Button } from '@/ui/atoms'
import { SectionLabel } from './chrome'
import { toast } from './toasts'

// The team-name field of Settings → Admin (1.5). Its own component because it
// is the one thing in that panel with state of its own — what is typed, and
// whether a save is in flight.
//
// Renaming the team is an admin-only act: the panel around this field is shown
// only to Gil, `ChatService.renameTeam` throws `not-admin` for anyone else, and
// every other client ignores a `team-renamed` event whose author is not an
// admin (main/services/teamSettings.ts). The change is still an ordinary signed
// event in the team log, so "who renamed it" stays answerable after the fact —
// the toast every other client shows says so.
export default function TeamSettings() {
  const boot = useStore((s) => s.boot)
  const teamName = selfOf(boot)?.teamName ?? ''
  const [value, setValue] = useState(teamName)
  const [saving, setSaving] = useState(false)
  const lastSeen = useRef(teamName)

  // The field follows the *authoritative* name whenever it actually moves —
  // our own save landing, or somebody else's rename arriving on the `team`
  // push — and never otherwise, so it cannot overwrite what is being typed.
  useEffect(() => {
    if (lastSeen.current === teamName) return
    lastSeen.current = teamName
    setValue(teamName)
  }, [teamName])

  const clean = normalizeTeamName(value)
  const valid = isValidTeamName(clean)
  const changed = clean !== teamName
  const disabled = !valid || !changed || saving

  async function save() {
    if (disabled) return
    setSaving(true)
    // The name before the call, so a rename that turned out to be a no-op
    // (main returns `{ queued: false }` without publishing) cannot toast
    // "Team renamed to …" over an event that was never written.
    const before = teamName
    try {
      const { queued } = await window.bridge.team.rename(clean)
      const notice = teamRenameSaveNotice({ before, name: clean, queued })
      toast(notice.text, notice.tone)
    } catch (err) {
      toast(teamRenameFailureNotice(err instanceof Error ? err.message : String(err)), 'danger')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SectionLabel>Team name</SectionLabel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          className="sem-input"
          value={value}
          maxLength={TEAM_NAME_MAX}
          aria-label="Team name"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
          style={{ maxWidth: 280 }}
        />
        <Button disabled={disabled} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: '15px' }}>
        Only you can change this — everyone else's Chat ignores a rename from anybody but Gil — and everyone sees the
        new name within a few seconds: it is the name in the sidebar. 1–{TEAM_NAME_MAX} characters. Teammates still on
        an older Chat keep seeing the original name.
      </div>
    </div>
  )
}
