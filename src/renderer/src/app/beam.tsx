import { useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { IconBolt } from './icons'
import { toast } from './toasts'

// Drag-to-beam (spec §5.2): dropping files on a person sends them directly to
// that machine. This hook powers every user row (sidebar DMs, member list).

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files')
}

export interface BeamTarget {
  over: boolean
  /** This row cannot accept a beam — the label says so instead of promising one. */
  blocked?: boolean
  props: {
    onDragEnter(e: DragEvent<HTMLElement>): void
    onDragOver(e: DragEvent<HTMLElement>): void
    onDragLeave(e: DragEvent<HTMLElement>): void
    onDrop(e: DragEvent<HTMLElement>): void
  }
}

/**
 * `canReceive: false` keeps the row a drop *target* — it still swallows the
 * drag, so nothing falls through to the conversation behind it — but nothing
 * is ever sent. The one row this is for is the DM of a device its owner
 * replaced by re-joining (1.4): it is deliberately still listed, under
 * "(previous device)", because it holds history — and there is nobody behind
 * it to accept a beam, so a file dropped there would be offered to a machine
 * that can never answer and sit "waiting" until it timed out.
 */
export function useBeamTarget(peerDeviceId: string, peerName: string, canReceive = true): BeamTarget {
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  return {
    over,
    blocked: !canReceive,
    props: {
      onDragEnter(e) {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        depth.current += 1
        setOver(true)
      },
      onDragOver(e) {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave() {
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      },
      onDrop(e) {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        depth.current = 0
        setOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (!files.length) return
        if (!canReceive) {
          toast(`${peerName} isn't on the share any more — beam to their current device instead`, 'danger')
          return
        }
        void (async () => {
          try {
            const paths = files.map((f) => window.bridge.files.pathForFile(f))
            await window.bridge.beams.send(peerDeviceId, paths)
            toast(
              files.length === 1 ? `Beaming ${files[0].name} to ${peerName}` : `Beaming ${files.length} files to ${peerName}`,
              'flare',
            )
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (/not.?implemented/i.test(msg)) toast('Beaming lands in the next build', 'info')
            else toast(`Beam failed — ${msg}`, 'danger')
          }
        })()
      },
    },
  }
}

/** The morphed row content shown while files hover over a person. */
export function BeamLabel({ name, blocked }: { name: string; blocked?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, pointerEvents: 'none', minWidth: 0 }}>
      <span style={{ color: blocked ? 'var(--text-3)' : 'var(--flare)', flexShrink: 0 }}>
        <IconBolt size={18} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 12,
            fontWeight: 600,
            color: blocked ? 'var(--text-2)' : 'var(--text-1)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {blocked ? `Can't beam to ${name}` : `Beam to ${name}`}
        </span>
        <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
          {blocked ? 'this device is no longer on the share' : 'directly to their machine'}
        </span>
      </span>
    </div>
  )
}
