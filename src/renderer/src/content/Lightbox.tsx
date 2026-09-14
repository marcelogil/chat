import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Attachment, MsgPayload } from '@shared/types'
import { useStore } from '@/store'
import { DRAG, NO_DRAG, overlayChromeInsets } from '@/app/chrome'
import { formatBytes } from '@/ui/atoms'
import { middleTruncate } from './parse'
import { useBlobMedia } from './useBlobMedia'
import { CloseIcon, DownloadIcon } from './icons'
import './content.css'

// Spec §4.1 — full-window media lightbox. Reads store.lightbox itself; renders
// nothing when closed. Esc or click-outside closes; Save As streams from the
// blob service.
//
// The media element lives in its own component below so the sfblob:// retry
// hook runs under the rules of hooks: this one returns null when closed.

function findAttachment(
  events: ReturnType<typeof useStore.getState>['events'][string] | undefined,
  eventId: string,
  blobId: string,
): Attachment | null {
  if (!events) return null
  // Fast path: the exact event.
  for (const ev of events) {
    if (ev.id === eventId && ev.payload.t === 'msg') {
      const att = (ev.payload as MsgPayload).attachments?.find((a) => a.blobId === blobId)
      if (att) return att
    }
  }
  // Fallback: any message in the conversation carrying this blob.
  for (const ev of events) {
    if (ev.payload.t === 'msg') {
      const att = (ev.payload as MsgPayload).attachments?.find((a) => a.blobId === blobId)
      if (att) return att
    }
  }
  return null
}

export function Lightbox() {
  const lightbox = useStore((s) => s.lightbox)
  const events = useStore((s) => (lightbox ? s.events[lightbox.conv] : undefined))
  // Where the OS window buttons are, in this overlay's coordinates. Fullscreen
  // hides them, so the strip goes back to its natural padding there.
  const fullscreen = useStore((s) => s.fullscreen)
  const chromeInsets = overlayChromeInsets(window.bridge.platform, fullscreen)
  const [note, setNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const att = useMemo(
    () => (lightbox ? findAttachment(events, lightbox.eventId, lightbox.blobId) : null),
    [lightbox, events],
  )

  const open = lightbox !== null && att !== null

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useStore.getState().openLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Reset transient state when the target changes.
  useEffect(() => {
    setNote(null)
  }, [lightbox?.blobId])

  if (!open || !att) return null

  const close = (): void => useStore.getState().openLightbox(null)

  const saveAs = (): void => {
    window.bridge.files.saveBlobAs(att.blobId, att.name).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      setNote(
        msg.includes('not-implemented')
          ? 'File service lands in the next build'
          : 'Could not save — the share may be unreachable',
      )
      if (noteTimer.current) clearTimeout(noteTimer.current)
      noteTimer.current = setTimeout(() => setNote(null), 2600)
    })
  }

  return (
    <div
      className="sem-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Media viewer: ${att.name}`}
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Top chrome. Same rule as the diagram editor's header (1.4): this strip
          sits over the shell's drag region, which Chromium computes from the
          DOM and not from z-order — so it takes the region over (the window can
          still be moved by it) and every control in it opts out with NO_DRAG,
          while the content is inset past the OS's own window buttons. */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          ...DRAG,
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 52,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingLeft: 16 + chromeInsets.left,
          paddingRight: 12 + chromeInsets.right,
          userSelect: 'none',
        }}
      >
        <span style={{ ...NO_DRAG, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap' }}>
            {middleTruncate(att.name, 48)}
          </span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap' }}>
            {formatBytes(att.size)}
          </span>
        </span>
        <span style={{ flex: 1 }} />
        {note && (
          <span style={{ ...NO_DRAG, fontSize: 12, color: 'var(--warning)', whiteSpace: 'nowrap' }}>{note}</span>
        )}
        <button
          onClick={saveAs}
          title={`Save ${att.name} as…`}
          aria-label={`Save ${att.name} as…`}
          style={{
            ...NO_DRAG,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 28,
            padding: '0 10px',
            border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: 'var(--r-sm)',
            background: 'rgba(255,255,255,0.08)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 500,
            fontFamily: 'var(--font-ui)',
            cursor: 'pointer',
          }}
        >
          <DownloadIcon size={13} />
          Save As
        </button>
        <button
          onClick={close}
          title="Close (Esc)"
          aria-label="Close media viewer"
          style={{
            ...NO_DRAG,
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            borderRadius: 'var(--r-sm)',
            background: 'rgba(255,255,255,0.08)',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          <CloseIcon size={15} />
        </button>
      </div>

      {/* Media, centered and scaled to fit */}
      <div className="sem-lightbox-media" onClick={(e) => e.stopPropagation()} style={{ display: 'flex' }}>
        <LightboxMedia att={att} />
      </div>
    </div>
  )
}

/**
 * The picture (or video), with the same retry as the inline tile: a blob that
 * answers 503 because the share is away — or because the app has only just
 * relaunched — comes back on its own instead of leaving a broken frame open.
 */
function LightboxMedia({ att }: { att: Attachment }) {
  const media = useBlobMedia(att)
  const isVideo = att.mime.startsWith('video/')
  const settling = media.phase !== 'ok'

  const fit: CSSProperties = {
    maxWidth: 'calc(100vw - 96px)',
    maxHeight: 'calc(100vh - 128px)',
    borderRadius: 'var(--r-md)',
    boxShadow: 'var(--elev-3)',
    // A failed element has no intrinsic size, so the note below would have
    // nothing to sit on; fade it out rather than unmount it, because the `src`
    // swap on the element that stayed is what makes the retry a new request.
    opacity: media.phase === 'retrying' ? 0 : 1,
  }

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: settling ? 320 : undefined,
        minHeight: settling ? 200 : undefined,
      }}
    >
      {media.phase !== 'expired' &&
        (isVideo ? (
          <video
            src={media.src}
            controls
            autoPlay
            aria-label={att.name}
            onError={media.onError}
            onLoadedMetadata={media.onLoad}
            style={fit}
          />
        ) : (
          <img
            src={media.src}
            alt={att.name}
            draggable={false}
            onError={media.onError}
            onLoad={media.onLoad}
            style={{ ...fit, objectFit: 'contain' }}
          />
        ))}
      {settling && media.phase !== 'loading' && (
        <span
          aria-live="polite"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              padding: '4px 10px',
              borderRadius: 'var(--r-full)',
              background: 'rgba(0, 0, 0, 0.55)',
              color: 'rgba(255, 255, 255, 0.85)',
              fontSize: 12,
              lineHeight: '18px',
            }}
          >
            {media.phase === 'expired' ? '🧹 this file was cleaned up by retention' : 'file service warming up'}
          </span>
        </span>
      )}
    </div>
  )
}
