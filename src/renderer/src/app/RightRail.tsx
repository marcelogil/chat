import { useMemo } from 'react'
import type { Attachment, ConvId, MsgPayload, PresenceView } from '@shared/types'
import { materialize } from '@shared/merge'
import { RETENTION } from '@shared/constants'
import { useStore, selfOf } from '@/store'
import { safeThumbSrc } from '@/content/parse'
import { Avatar, formatBytes, formatTime, IconButton } from '@/ui/atoms'
import { SectionLabel, truncate } from './chrome'
import { IconFile, IconLock, IconPin, IconX } from './icons'
import { useBeamTarget, BeamLabel } from './beam'
import { openDm, useDmMap, useGroupMap } from './dm'
import { groupMemberRows } from './groupMembers'
import { PersonLines } from './PersonLines'

// Spec §2.4 — right rail: About / Members / Files / Pinned. Member rows are
// beam drop targets, same as sidebar DM rows.

export type RailTab = 'about' | 'members' | 'files' | 'pinned'

const TABS: { id: RailTab; label: string }[] = [
  { id: 'about', label: 'About' },
  { id: 'members', label: 'Members' },
  { id: 'files', label: 'Files' },
  { id: 'pinned', label: 'Pinned' },
]

function MemberRow({ p, isSelf }: { p: PresenceView; isSelf: boolean }) {
  const beam = useBeamTarget(p.deviceId, p.name)
  const beamProps = isSelf ? {} : beam.props
  return (
    <button
      className="sem-row"
      onClick={() => {
        if (!isSelf) void openDm(p.deviceId)
      }}
      title={`${isSelf ? `${p.name} (you)` : `Message ${p.name}`} — device ${p.hostname}·${p.fingerprint}${p.status ? `\n${p.status}` : ''}`}
      aria-label={`${isSelf ? `${p.name}, you` : `Member ${p.name}, ${p.state}`}${p.status ? `, status ${p.status}` : ''}`}
      {...beamProps}
      style={{
        width: '100%',
        minHeight: beam.over ? 52 : 44,
        gap: 10,
        padding: '0 10px',
        borderRadius: 'var(--r-sm)',
        background: beam.over ? 'var(--flare-soft)' : undefined,
        boxShadow: beam.over ? 'inset 0 0 0 1px var(--flare)' : undefined,
        cursor: isSelf ? 'default' : 'pointer',
        transition:
          'min-height var(--t-fast) var(--ease-standard), background var(--t-fast) var(--ease-standard), box-shadow var(--t-fast) var(--ease-standard)',
      }}
    >
      {beam.over ? (
        <BeamLabel name={p.name} />
      ) : (
        <>
          <Avatar name={p.name} size={28} presence={p.state} desaturate={p.state === 'away'} />
          {/* The status is the second line, always — and the identity chip
              waits for a hover instead of sitting next to every name (1.4). */}
          <PersonLines
            name={p.name}
            suffix={isSelf ? ' (you)' : undefined}
            status={p.status}
            state={p.state}
            departed={p.departed}
            hostname={p.hostname}
            fingerprint={p.fingerprint}
            warn={p.trust === 'flagged'}
            nameWeight={500}
            nameColor={p.state === 'offline' ? 'var(--text-3)' : 'var(--text-1)'}
          />
        </>
      )}
    </button>
  )
}

export default function RightRail({
  conv,
  tab,
  onTab,
  onClose,
}: {
  conv: ConvId
  tab: RailTab
  onTab: (t: RailTab) => void
  onClose: () => void
}) {
  const channels = useStore((s) => s.channels)
  const presence = useStore((s) => s.presence)
  const selfPresence = useStore((s) => s.selfPresence)
  const events = useStore((s) => s.events[conv])
  const boot = useStore((s) => s.boot)
  const dmPeers = useDmMap((s) => s.peers)
  const groupMap = useGroupMap()
  const self = selfOf(boot)

  const channel = channels.find((c) => c.conv === conv)
  const group = groupMap[conv]
  const peer = presence.find((p) => p.deviceId === dmPeers[conv])

  const { pinnedMsgs, files } = useMemo(() => {
    const log = materialize(events ?? [])
    const pins = log.messages.filter((m) => m.pinned && !m.deleted)
    const fs: { att: Attachment; sender: string; when: number }[] = []
    for (const ev of events ?? []) {
      if (ev.payload.t !== 'msg') continue
      const mp = ev.payload as MsgPayload
      for (const att of mp.attachments ?? []) fs.push({ att, sender: mp.author.name, when: mp.sentWall })
    }
    fs.reverse()
    return { pinnedMsgs: pins.reverse(), files: fs }
  }, [events])

  const sortedMembers = useMemo(() => {
    const rank = { online: 0, away: 1, offline: 2 } as const
    return presence
      .filter((p) => !p.departed)
      .sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
  }, [presence])

  // A group's Members tab is the group's own roster (owner + members), not
  // the whole team — and unlike the channel/DM roster, it must include the
  // local device itself (see groupMemberRows). The identity object is built
  // fresh every render either way (it's cheap) — what matters is that the
  // memo's dep list names the primitive fields, not that object, so an
  // unrelated re-render (a new `boot`/`self` reference with the same values)
  // doesn't defeat the memo by always looking "changed".
  const groupMembers = useMemo(
    () =>
      group
        ? groupMemberRows(
            group.members,
            presence,
            self
              ? {
                  deviceId: self.deviceId,
                  name: self.displayName,
                  hostname: self.hostname,
                  fingerprint: self.fingerprint,
                  // 1.4: our own status belongs on our own row here too.
                  status: selfPresence?.status,
                  state: selfPresence?.state,
                }
              : null,
            group.conv,
          )
        : [],
    [
      group,
      presence,
      self?.deviceId,
      self?.displayName,
      self?.hostname,
      self?.fingerprint,
      selfPresence?.status,
      selfPresence?.state,
    ],
  )
  const memberRows = group ? groupMembers : sortedMembers

  return (
    <div
      style={{
        width: 320,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-panel)',
        borderLeft: '1px solid var(--border-subtle)',
        minHeight: 0,
      }}
    >
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '0 8px',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            className="sem-row sem-focus"
            onClick={() => onTab(t.id)}
            title={t.label}
            aria-label={`${t.label} tab`}
            aria-selected={tab === t.id}
            role="tab"
            style={{
              height: 28,
              padding: '0 10px',
              borderRadius: 'var(--r-sm)',
              fontSize: 12,
              fontWeight: tab === t.id ? 600 : 400,
              color: tab === t.id ? 'var(--accent-text)' : 'var(--text-3)',
              background: tab === t.id ? 'var(--accent-soft)' : undefined,
            }}
          >
            {t.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <IconButton label="Close details" onClick={onClose}>
          <IconX size={15} />
        </IconButton>
      </div>

      <div className="sem-scroll" style={{ flex: 1, minHeight: 0, padding: 12 }}>
        {tab === 'about' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {channel ? (
              <>
                <div>
                  <SectionLabel style={{ marginBottom: 6 }}>Topic</SectionLabel>
                  <div style={{ fontSize: 13, color: channel.topic ? 'var(--text-1)' : 'var(--text-3)', userSelect: 'text' }}>
                    {channel.topic || 'No topic yet.'}
                  </div>
                </div>
                <div>
                  <SectionLabel style={{ marginBottom: 6 }}>Channel</SectionLabel>
                  <div style={{ fontSize: 13, color: 'var(--text-2)' }}>#{channel.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                    {channel.channelId}
                  </div>
                </div>
              </>
            ) : group ? (
              <div>
                <SectionLabel style={{ marginBottom: 6 }}>Group</SectionLabel>
                <div style={{ fontSize: 13, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <IconLock size={13} /> {group.name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                  {group.role === 'owner' ? 'You own this group. ' : ''}
                  Only {group.members.length} people can read it — invites travel as a direct message, so nobody else
                  on the team can see who's in it. Only the owner can add or remove people.
                </div>
              </div>
            ) : (
              <div>
                <SectionLabel style={{ marginBottom: 6 }}>Conversation</SectionLabel>
                <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
                  {peer ? `Just you and ${peer.name}.` : 'Direct message.'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                  Messages are end-to-end encrypted; beams go device-to-device.
                </div>
              </div>
            )}
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-3)',
                background: 'var(--bg-raised)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--r-md)',
                padding: '8px 10px',
                lineHeight: '17px',
              }}
            >
              Files older than {RETENTION.blobDays} days and messages older than {RETENTION.eventDays} days are
              auto-cleaned from the shared folder.
            </div>
          </div>
        )}

        {tab === 'members' && (
          <div role="list" aria-label="Members" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {memberRows.map((p) => (
              <MemberRow key={p.deviceId} p={p} isSelf={p.deviceId === self?.deviceId} />
            ))}
            {!memberRows.length && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', padding: 8 }}>No members seen yet.</div>
            )}
          </div>
        )}

        {tab === 'files' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {files.map(({ att, sender, when }, i) => (
              <div
                key={`${att.blobId}:${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 'var(--r-md)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-raised)',
                }}
              >
                {safeThumbSrc(att.thumb) ? (
                  <img
                    src={safeThumbSrc(att.thumb)}
                    alt=""
                    style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 'var(--r-sm)', flexShrink: 0 }}
                  />
                ) : (
                  <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>
                    <IconFile size={20} />
                  </span>
                )}
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ ...truncate, display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-1)', userSelect: 'text' }}>
                    {att.name}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)' }}>
                    {formatBytes(att.size)} · {sender} · {formatTime(when)}
                  </span>
                </span>
              </div>
            ))}
            {!files.length && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', padding: 8, textAlign: 'center' }}>
                Nothing shared here yet. Drop a file into the conversation.
              </div>
            )}
          </div>
        )}

        {tab === 'pinned' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pinnedMsgs.map((m) => (
              <div
                key={m.id}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--r-md)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-raised)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ color: 'var(--accent-text)' }}>
                    <IconPin size={12} />
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>{m.authorName}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{formatTime(m.sentWall)}</span>
                </div>
                <div className="sem-clamp2" style={{ fontSize: 12, color: 'var(--text-2)', userSelect: 'text' }}>
                  {m.body.text || (m.attachments.length ? `${m.attachments.length} attachment(s)` : '')}
                </div>
              </div>
            ))}
            {!pinnedMsgs.length && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', padding: 8, textAlign: 'center' }}>
                No pinned messages. Pin one from its hover menu.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
