import { useEffect, useMemo, useRef, useState } from 'react'
import type { GroupView } from '@shared/bridge'
import { useStore, selfOf } from '@/store'
import { Avatar, Button } from '@/ui/atoms'
import { SectionLabel } from './chrome'
import { trapTabWithin } from './ChannelMenu'
import { IconLock, IconSearch, IconX } from './icons'
import { toast } from './toasts'
import { memberRowSuffix, pickAddCandidates } from './groupMembers'
import { PersonLines } from './PersonLines'
import { presenceLine } from './presenceLine'

// Private-group dialog (1.2): name + member picker from presence, chips,
// search — reused for both "Add people…" and "Manage members…" (the latter
// adds inline remove buttons for the owner). Same scrim/dialog pattern as
// CalendarDialog/PrsPrefs.

const MAX_NAME = 60

export function GroupDialog({
  mode,
  group,
  canRemove,
  onClose,
}: {
  /** 'create' has a name field and no existing members; 'edit' operates on `group`. */
  mode: 'create' | 'edit'
  group?: GroupView
  /** Owner-only "Manage members" — shows inline Remove buttons. Ignored in 'create' mode. */
  canRemove?: boolean
  onClose: () => void
}) {
  const presence = useStore((s) => s.presence)
  const selfPresence = useStore((s) => s.selfPresence)
  const boot = useStore((s) => s.boot)
  const setActiveConv = useStore((s) => s.setActiveConv)
  const self = selfOf(boot)
  // Our own row in "Current members" reads the same self presence the footer
  // does — `presence` is everyone else (1.4).
  const selfState = selfPresence?.state ?? 'online'

  const [name, setName] = useState(group?.name ?? '')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (mode === 'create') nameRef.current?.focus()
    else searchRef.current?.focus()
  }, [mode])

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const currentMembers = group?.members ?? []
  const candidates = useMemo(
    () => pickAddCandidates(presence, self?.deviceId ?? '', currentMembers, query),
    [presence, self?.deviceId, currentMembers, query],
  )

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const trimmedName = name.trim().slice(0, MAX_NAME)

  async function submitCreate() {
    // A group of one (just the owner) can't happen — pick at least one other
    // member to invite before Create is even enabled.
    if (!trimmedName || selected.size === 0 || busy) return
    setBusy(true)
    try {
      const g = await window.bridge.groups.create(trimmedName, [...selected])
      setActiveConv(g.conv)
      toast(`Created 🔒 ${g.name}`, 'success')
      onClose()
    } catch (err) {
      toast(`Could not create the group — ${err instanceof Error ? err.message : String(err)}`, 'danger')
      setBusy(false)
    }
  }

  async function submitAdd() {
    if (!group || selected.size === 0 || busy) return
    setBusy(true)
    try {
      await window.bridge.groups.addMembers(group.conv, [...selected])
      toast(selected.size === 1 ? 'Person added' : 'People added', 'success')
      onClose()
    } catch (err) {
      toast(`Could not add them — ${err instanceof Error ? err.message : String(err)}`, 'danger')
      setBusy(false)
    }
  }

  async function removeMember(deviceId: string) {
    if (!group || busy) return
    setBusy(true)
    try {
      await window.bridge.groups.removeMember(group.conv, deviceId)
      toast('Member removed', 'success')
      setRemoving(null)
    } catch (err) {
      toast(`Could not remove them — ${err instanceof Error ? err.message : String(err)}`, 'danger')
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'create' ? 'New group' : canRemove ? `Manage members` : `Add people`
  // A half-filled form (a typed name, or anyone picked to add) is worth
  // protecting from a stray click on the scrim — only an explicit Cancel or
  // Escape discards it once there's something to lose.
  const dirty = (mode === 'create' && trimmedName !== '') || selected.size > 0

  return (
    <div
      onClick={dirty ? undefined : onClose}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'sem-fade var(--t-fast) var(--ease-standard)',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={group ? `${title} · ${group.name}` : title}
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => trapTabWithin(dialogRef.current, e)}
        style={{
          width: 440,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 48px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--elev-3)',
          overflow: 'hidden',
          animation: 'sem-pop var(--t-base) var(--ease-pop)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '16px 20px 12px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ color: 'var(--text-3)', display: 'flex' }}>
            <IconLock size={14} />
          </span>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>{title}</span>
          {group && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>· {group.name}</span>}
        </div>

        <div className="sem-scroll" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
          {mode === 'create' && (
            <div>
              <SectionLabel style={{ marginBottom: 6 }}>Name</SectionLabel>
              <input
                ref={nameRef}
                className="sem-input"
                value={name}
                maxLength={MAX_NAME}
                placeholder="Project Firefly"
                aria-label="Group name"
                title="Group name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitCreate()
                }}
              />
            </div>
          )}

          {mode === 'edit' && currentMembers.length > 0 && (
            <div>
              <SectionLabel style={{ marginBottom: 6 }}>Current members</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {currentMembers.map((id) => {
                  const p = presence.find((pp) => pp.deviceId === id)
                  const isOwner = id === group?.owner
                  const isSelf = id === self?.deviceId
                  const displayName = isSelf ? (self?.displayName ?? 'you') : (p?.name ?? `${id.slice(0, 8)}…`)
                  // A device the same person replaced by re-joining (1.4) is
                  // still on the membership list holding a key, so — unlike
                  // the members rail — this dialog keeps its row and says
                  // which device it is. `memberRowSuffix` carries that into
                  // the name line and into the Remove button's label.
                  const suffix = memberRowSuffix(p, { owner: isOwner, self: isSelf })
                  const rowName = `${displayName}${suffix}`
                  const rowState = isSelf ? selfState : (p?.state ?? 'offline')
                  const rowStatus = isSelf ? selfPresence?.status : p?.status
                  // Name and status only — never the identity chip: it is
                  // hover/focus-revealed on purpose (see chrome.tsx), and a
                  // screen reader reading this row's label shouldn't get it
                  // read out every time regardless.
                  const rowLabel = `${rowName}, ${presenceLine({ status: rowStatus, state: rowState, departed: p?.departed, self: isSelf }).text}`
                  return (
                    <div
                      key={id}
                      className="sem-row"
                      aria-label={rowLabel}
                      style={{ height: 42, gap: 8, padding: '0 6px', borderRadius: 'var(--r-sm)' }}
                    >
                      <Avatar name={displayName} size={22} presence={isSelf ? selfState : p?.state} />
                      {/* Name, then their status — the same two lines as
                          every other person row (1.4). */}
                      <PersonLines
                        name={displayName}
                        suffix={suffix}
                        status={rowStatus}
                        state={rowState}
                        departed={p?.departed}
                        hostname={isSelf ? self?.hostname : p?.hostname}
                        fingerprint={isSelf ? self?.fingerprint : p?.fingerprint}
                        warn={p?.trust === 'flagged'}
                      />
                      {canRemove &&
                        !isOwner &&
                        !isSelf &&
                        (removing === id ? (
                          <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                            <Button
                              variant="danger"
                              disabled={busy}
                              onClick={() => void removeMember(id)}
                              style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                            >
                              Remove
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setRemoving(null)}
                              style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                            >
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <button
                            className="sem-row sem-focus"
                            title={`Remove ${rowName}`}
                            aria-label={`Remove ${rowName}`}
                            onClick={() => setRemoving(id)}
                            style={{
                              width: 22,
                              height: 22,
                              flexShrink: 0,
                              alignItems: 'center',
                              justifyContent: 'center',
                              borderRadius: 'var(--r-xs)',
                              color: 'var(--text-3)',
                            }}
                          >
                            <IconX size={12} />
                          </button>
                        ))}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div>
            <SectionLabel style={{ marginBottom: 6 }}>{mode === 'create' ? 'Add people' : 'Add more people'}</SectionLabel>
            {selected.size > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {[...selected].map((id) => {
                  const p = presence.find((pp) => pp.deviceId === id)
                  return (
                    <span
                      key={id}
                      className="sem-chip-btn"
                      style={{ height: 24, paddingRight: 6, cursor: 'default' }}
                    >
                      {p?.name ?? `${id.slice(0, 8)}…`}
                      <button
                        onClick={() => toggle(id)}
                        title="Remove from selection"
                        aria-label={`Remove ${p?.name ?? 'person'} from selection`}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: 'inherit',
                          cursor: 'pointer',
                          display: 'flex',
                          padding: 0,
                        }}
                      >
                        <IconX size={11} />
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
            <div style={{ position: 'relative', marginBottom: 6 }}>
              <span
                aria-hidden="true"
                style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }}
              >
                <IconSearch size={13} />
              </span>
              <input
                ref={searchRef}
                className="sem-input"
                style={{ paddingLeft: 26 }}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people…"
                aria-label="Search people"
                spellCheck={false}
              />
            </div>
            <div
              className="sem-scroll"
              style={{ maxHeight: 160, border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: 4 }}
            >
              {candidates.length === 0 ? (
                <div style={{ padding: 10, fontSize: 12, color: 'var(--text-3)' }}>
                  {presence.length === 0 ? 'Nobody else is on the team folder yet.' : 'No match.'}
                </div>
              ) : (
                candidates.map((p) => (
                  <label
                    key={p.deviceId}
                    className="sem-row"
                    aria-label={`${p.name}, ${presenceLine({ status: p.status, state: p.state, departed: p.departed }).text}`}
                    style={{ height: 42, gap: 8, padding: '0 8px', borderRadius: 'var(--r-sm)' }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(p.deviceId)}
                      onChange={() => toggle(p.deviceId)}
                      style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                      aria-label={`Include ${p.name}`}
                    />
                    <Avatar name={p.name} size={22} presence={p.state} desaturate={p.state === 'away'} />
                    <PersonLines
                      name={p.name}
                      status={p.status}
                      state={p.state}
                      departed={p.departed}
                      hostname={p.hostname}
                      fingerprint={p.fingerprint}
                      warn={p.trust === 'flagged'}
                    />
                  </label>
                ))
              )}
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 20px 16px',
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ flex: 1 }} />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {mode === 'create' ? (
            <Button disabled={!trimmedName || selected.size === 0 || busy} onClick={() => void submitCreate()}>
              {busy ? 'Creating…' : 'Create'}
            </Button>
          ) : (
            <Button disabled={selected.size === 0 || busy} onClick={() => void submitAdd()}>
              {busy ? 'Adding…' : `Add${selected.size ? ` (${selected.size})` : ''}`}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
