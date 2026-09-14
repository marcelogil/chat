import type { PresenceStateKind } from '@shared/types'
import { DeviceChip } from '@/ui/atoms'
import { truncate } from './chrome'
import { presenceLine } from './presenceLine'

// The two-line person block (1.4): name, then the status underneath.
//
// One component for every place a person is listed — sidebar DM rows, the
// members rail, group member lists, the DM header — so the second line says
// the same thing everywhere and the identity chip behaves the same way
// everywhere: parked at the end of the status line at zero opacity, revealed
// when the row is hovered or focused (`.sem-chip-reveal`, chrome.tsx). The
// chip is absolutely positioned, so it costs the status no width and takes
// the line only while you are actually looking for it.

export function PersonLines({
  name,
  suffix,
  status,
  state,
  departed,
  self,
  hostname,
  fingerprint,
  warn,
  nameSize = 13,
  nameWeight = 400,
  nameColor = 'var(--text-1)',
}: {
  name: string
  /** " (you)", " · owner" — part of the name line, never of the status. */
  suffix?: string
  status?: string | null
  state: PresenceStateKind
  departed?: boolean
  self?: boolean
  /** Both halves of the chip, or neither: without them the line is status only. */
  hostname?: string
  fingerprint?: string
  warn?: boolean
  nameSize?: number
  nameWeight?: number
  nameColor?: string
}) {
  const line = presenceLine({ status, state, departed, self })
  const chip = hostname && fingerprint
  return (
    <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
      <span
        style={{
          ...truncate,
          display: 'block',
          fontSize: nameSize,
          fontWeight: nameWeight,
          color: nameColor,
          lineHeight: `${Math.round(nameSize * 1.3)}px`,
        }}
      >
        {name}
        {suffix ?? ''}
      </span>
      <span
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          minWidth: 0,
          height: 16,
          marginTop: 1,
        }}
      >
        <span
          title={line.muted ? undefined : line.text}
          style={{
            ...truncate,
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            lineHeight: '16px',
            color: line.muted ? 'var(--text-3)' : 'var(--text-2)',
          }}
        >
          {line.text}
        </span>
        {chip &&
          // A flagged device is the one chip that never hides: "a new device
          // claiming a known name gets flagged loudly" is the whole point of
          // it, and loudly means without hovering. It keeps its place in the
          // line rather than covering the status.
          (warn ? (
            <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, marginLeft: 6 }}>
              <DeviceChip hostname={hostname} fingerprint={fingerprint} warn />
            </span>
          ) : (
            <span
              className="sem-chip-reveal"
              style={{ position: 'absolute', right: 0, top: 0, display: 'flex', alignItems: 'center', height: 16 }}
            >
              <DeviceChip hostname={hostname} fingerprint={fingerprint} />
            </span>
          ))}
      </span>
    </span>
  )
}
