import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ConvId } from '@shared/types'
import { useStore } from '@/store'
import { Avatar, IconButton, identityHue } from '@/ui/atoms'
import { ShareButton } from '@/screenshare/ShareUi'
import { truncate } from './chrome'
import { IconLock, IconPanel, IconPencil, IconPin } from './icons'
import { ConvRenameInput } from './ConvRename'
import { FIXED_CHANNEL_REFUSAL, type RenameKind } from './renamePlan'
import { useDmMap, useGroupMap } from './dm'
import { PersonLines } from './PersonLines'
import type { RailTab } from './RightRail'

// Spec §2.3 — 52px conversation header with the right-rail controls.

/**
 * The name, as a button that starts the inline rename (1.5), with a pencil
 * beside it so the affordance is visible rather than folklore. The home
 * channel keeps a plain label and says why in its tooltip.
 */
function HeaderName({
  name,
  kind,
  fixed,
  onRename,
  children,
}: {
  name: string
  kind: RenameKind
  fixed?: boolean
  onRename: () => void
  children?: ReactNode
}) {
  const [hover, setHover] = useState(false)
  const label = { fontSize: 17, fontWeight: 600, color: 'var(--text-1)', whiteSpace: 'nowrap' } as const
  if (fixed) {
    return (
      <>
        {children}
        <span title={FIXED_CHANNEL_REFUSAL} style={label}>
          {name}
        </span>
      </>
    )
  }
  return (
    <span
      style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
      {/* The pencil lives *inside* the button: a revealed affordance that does
          nothing when clicked is worse than no affordance at all. */}
      <button
        className="sem-focus"
        onClick={onRename}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        title={`Rename ${kind === 'channel' ? `#${name}` : name}`}
        aria-label={`Rename ${kind === 'channel' ? `#${name}` : name}`}
        style={{
          ...label,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          minWidth: 0,
          padding: '2px 4px',
          margin: '0 -4px',
          border: 'none',
          background: 'transparent',
          borderRadius: 'var(--r-sm)',
          fontFamily: 'var(--font-ui)',
          cursor: 'text',
        }}
      >
        <span style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
        <span
          aria-hidden="true"
          style={{
            display: 'flex',
            flexShrink: 0,
            color: 'var(--text-3)',
            opacity: hover ? 1 : 0,
            transition: 'opacity var(--t-instant) var(--ease-standard)',
          }}
        >
          <IconPencil size={13} />
        </span>
      </button>
    </span>
  )
}

export default function ChannelHeader({
  conv,
  railOpen,
  railTab,
  onToggleRail,
  onOpenTab,
}: {
  conv: ConvId
  railOpen: boolean
  railTab: RailTab
  onToggleRail: () => void
  onOpenTab: (tab: RailTab) => void
}) {
  const channels = useStore((s) => s.channels)
  const presence = useStore((s) => s.presence)
  const dmPeers = useDmMap((s) => s.peers)
  const groupMap = useGroupMap()

  const channel = channels.find((c) => c.conv === conv)
  const group = groupMap[conv]
  const peer = presence.find((p) => p.deviceId === dmPeers[conv])
  const members = presence.filter((p) => !p.departed).length + 1
  // 1.5 — renaming from the header. Keyed on the conv so switching
  // conversations mid-edit can never land the typed name on the new one.
  const [renaming, setRenaming] = useState<ConvId | null>(null)
  const isRenaming = renaming === conv

  return (
    <div
      style={{
        height: 52,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 12px 0 16px',
        borderBottom: '1px solid var(--border-subtle)',
        minWidth: 0,
      }}
    >
      {channel ? (
        <>
          {isRenaming && !channel.fixed ? (
            <ConvRenameInput
              conv={conv}
              kind="channel"
              current={channel.name}
              fixed={channel.fixed}
              onDone={() => setRenaming(null)}
              style={{ height: 30, fontSize: 15, maxWidth: 320 }}
            />
          ) : (
            <HeaderName name={channel.name} kind="channel" fixed={channel.fixed} onRename={() => setRenaming(conv)}>
              <span
                aria-hidden="true"
                style={{
                  fontSize: 17,
                  fontWeight: 600,
                  color: identityHue(channel.name),
                  filter: 'saturate(0.6)',
                  userSelect: 'none',
                }}
              >
                #
              </span>
            </HeaderName>
          )}
          <span style={{ fontSize: 13, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
            {members} member{members === 1 ? '' : 's'}
          </span>
          {channel.topic ? (
            <span
              title={channel.topic}
              style={{
                ...truncate,
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                color: 'var(--text-3)',
                borderLeft: '1px solid var(--border-subtle)',
                paddingLeft: 10,
              }}
            >
              {channel.topic}
            </span>
          ) : (
            <span style={{ flex: 1 }} />
          )}
        </>
      ) : group ? (
        <>
          {isRenaming ? (
            <ConvRenameInput
              conv={conv}
              kind="group"
              current={group.name}
              onDone={() => setRenaming(null)}
              style={{ height: 30, fontSize: 15, maxWidth: 320 }}
            />
          ) : (
            <HeaderName name={group.name} kind="group" onRename={() => setRenaming(conv)}>
              <span aria-hidden="true" style={{ display: 'flex', color: 'var(--text-2)' }}>
                <IconLock size={16} />
              </span>
            </HeaderName>
          )}
          <span style={{ fontSize: 13, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
            {group.members.length} member{group.members.length === 1 ? '' : 's'}
          </span>
          <span style={{ flex: 1 }} />
        </>
      ) : peer ? (
        <>
          {/* Name over status, with the identity chip revealed on hover or
              keyboard focus of this block (1.4) — it used to sit between the
              name and the status and read as part of the name. */}
          <span
            className="sem-reveal-host"
            tabIndex={0}
            title={`${peer.name} — device ${peer.hostname}·${peer.fingerprint}${peer.status ? `\n${peer.status}` : ''}`}
            style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, borderRadius: 'var(--r-sm)' }}
          >
            <Avatar name={peer.name} size={24} presence={peer.state} />
            <PersonLines
              name={peer.name}
              status={peer.status}
              state={peer.state}
              departed={peer.departed}
              hostname={peer.hostname}
              fingerprint={peer.fingerprint}
              warn={peer.trust === 'flagged'}
              nameSize={17}
              nameWeight={600}
            />
          </span>
        </>
      ) : (
        <>
          <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)' }}>Direct message</span>
          <span style={{ flex: 1 }} />
        </>
      )}

      <ShareButton conv={conv} />
      <IconButton
        label={railOpen && railTab === 'pinned' ? 'Hide pinned messages' : 'Show pinned messages'}
        active={railOpen && railTab === 'pinned'}
        onClick={() => onOpenTab('pinned')}
      >
        <IconPin size={16} />
      </IconButton>
      <IconButton label={railOpen ? 'Hide details' : 'Show details'} active={railOpen} onClick={onToggleRail}>
        <IconPanel size={16} />
      </IconButton>
    </div>
  )
}
