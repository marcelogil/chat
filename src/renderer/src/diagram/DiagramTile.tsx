import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageView } from '@shared/merge'
import { DIAGRAM, RETENTION } from '@shared/constants'
import { diagramFileStem, diagramTileKind, diagramTitleOf, fitDiagramBox, isDiagramAttachment } from '@shared/diagram'
import { useStore } from '@/store'
import { NO_DRAG } from '@/app/chrome'
import { safeThumbSrc } from '@/content/parse'
import { decodeScene } from './codec'
import { bytesToBase64, fetchBlobScene } from './scene'

// The diagram message tile.
//
// Three states, in the order the eye gets them:
//   1. the WebP thumb that travelled in the event — painted immediately, with
//      no decode, no fetch and no Excalidraw;
//   2. a crisp SVG rendered locally from the scene, once the tile is actually
//      on screen and the lazy renderer has loaded (cached per event id);
//   3. for a blob-backed scene, whatever the blob store can give us — and an
//      honest "cleaned up" state when the 7-day sweep has taken it.
//
// Step 2 costs zero share I/O for an inline diagram: the scene is already in
// the message.

type Phase = 'thumb' | 'rendering' | 'svg' | 'expired' | 'failed'

export function DiagramTile({ view }: { view: MessageView }) {
  const d = view.body.diagram
  const kind = diagramTileKind(view.body, view.attachments.length)
  const [phase, setPhase] = useState<Phase>('thumb')
  const [svg, setSvg] = useState<string | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const started = useRef(false)
  const sceneJson = useRef<string | null>(null)
  // AppShell's rule: 'system' is the dark token set, so only 'light' is light.
  const dark = useStore((st) => st.settings?.theme) !== 'light'

  const title = diagramTitleOf(view.body.text)
  // The thumb travelled in the event, i.e. it is whatever the sender put there:
  // only an inline data: URI is displayable without calling out to a server.
  const thumb = safeThumbSrc(d?.thumb)
  const box = fitDiagramBox(d ?? { w: 420, h: 320 })
  const sceneAttachment = view.attachments.find(isDiagramAttachment) ?? view.attachments[0]

  // Render only what someone is actually looking at: a channel full of
  // diagrams must not decode and lay out every one of them on open.
  const load = useCallback(async () => {
    if (started.current || !d) return
    started.current = true
    setPhase('rendering')
    try {
      const json = d.data ? await decodeScene(d.data) : await fetchBlobScene(sceneAttachment)
      if (json === null) {
        setPhase('expired')
        return
      }
      sceneJson.current = json
      const { renderSvgMarkup } = await import('./render')
      setSvg(await renderSvgMarkup(`${view.id}|${dark ? 'dark' : 'light'}`, json, dark))
      setPhase('svg')
    } catch {
      setPhase('failed')
    }
  }, [d, sceneAttachment, view.id, dark])

  // Theme switch after the first render: re-render from the kept scene text
  // (cached per theme, so flipping back is free).
  useEffect(() => {
    const json = sceneJson.current
    if (!json || !started.current) return
    let live = true
    void import('./render').then(async ({ renderSvgMarkup }) => {
      try {
        const markup = await renderSvgMarkup(`${view.id}|${dark ? 'dark' : 'light'}`, json, dark)
        if (live) setSvg(markup)
      } catch {
        /* keep the previous rendering */
      }
    })
    return () => {
      live = false
    }
  }, [dark, view.id])

  useEffect(() => {
    const el = hostRef.current
    if (!el || kind === 'broken') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          void load()
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [kind, load])

  const openViewer = (): void => {
    if (!d) return
    void openDiagram(view, 'view')
  }
  const editCopy = (): void => {
    if (!d) return
    void openDiagram(view, 'edit')
  }
  const collaborate = (): void => {
    if (!d) return
    void openDiagram(view, 'live')
  }

  if (kind === 'broken' || !d) {
    return (
      <span style={{ fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
        📐 {title} — this diagram arrived without its drawing
      </span>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start', maxWidth: '100%' }}>
      <button
        className="sem-media-btn"
        onClick={openViewer}
        title={`Open ${title}`}
        aria-label={`Open the diagram ${title}`}
        style={{
          position: 'relative',
          width: box.w,
          height: box.h,
          maxWidth: '100%',
          padding: 0,
          borderRadius: 'var(--r-lg)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden',
          // Excalidraw's dark export inverts white to #121212; the letterbox
          // around the SVG must match it or the tile shows white bars.
          background: dark ? '#121212' : '#ffffff',
          boxSizing: 'border-box',
          cursor: 'zoom-in',
          flexShrink: 0,
        }}
      >
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }}>
          {phase === 'svg' && svg ? (
            // Locally rendered from the scene we already hold. The markup comes
            // from Excalidraw's own serializer in this same renderer — not from
            // the share — so there is no untrusted HTML crossing here.
            <div style={{ width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: svg }} />
          ) : phase === 'expired' ? (
            <CleanedUp />
          ) : thumb ? (
            <img
              src={thumb}
              alt={title}
              draggable={false}
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
          ) : (
            <Placeholder failed={phase === 'failed'} />
          )}
        </div>
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-3)', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-2)', fontWeight: 500 }}>{title}</span>
        <span>
          Diagram · {d.elements} shape{d.elements === 1 ? '' : 's'}
        </span>
        {kind === 'blob' && (
          <span title={`Large scenes ride the blob store, which is swept after ${RETENTION.blobDays} days`}>
            · kept {RETENTION.blobDays} days
          </span>
        )}
        <button onClick={editCopy} style={linkBtn} title="Open a copy you can change, and send it back as a reply">
          Edit a copy
        </button>
        <button
          onClick={collaborate}
          style={linkBtn}
          title="Open this as a live board — everyone in the conversation can join and draw on it with you"
        >
          Collaborate
        </button>
        <TileExport view={view} title={title} onError={() => setPhase('failed')} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

const linkBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  color: 'var(--accent-text)',
  fontSize: 12,
  fontFamily: 'var(--font-ui)',
  cursor: 'pointer',
}

function Placeholder({ failed }: { failed: boolean }) {
  return (
    <span
      className={failed ? undefined : 'sem-shimmer'}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-3)',
        fontSize: 12,
        background: 'var(--bg-raised)',
      }}
    >
      {failed ? 'this diagram could not be drawn' : '📐'}
    </span>
  )
}

function CleanedUp() {
  return (
    <span
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-raised)',
        color: 'var(--text-3)',
        fontSize: 12,
        padding: 12,
        textAlign: 'center',
      }}
    >
      <span aria-hidden style={{ fontSize: 18 }}>
        🧹
      </span>
      this diagram was cleaned up by retention
    </span>
  )
}

/**
 * Open the editor on an existing diagram. 'view' is read-only (Export still
 * works); 'edit' opens a copy whose Send lands as a reply — the discussion
 * loop, without live co-editing; 'live' (1.3) hosts a live board seeded with
 * this scene and its title, which is the co-editing loop.
 */
async function openDiagram(view: MessageView, mode: 'view' | 'edit' | 'live'): Promise<void> {
  const d = view.body.diagram
  if (!d) return
  const title = diagramTitleOf(view.body.text)
  let scene: string | null = null
  try {
    if (d.data) scene = await decodeScene(d.data)
    else {
      const att = view.attachments.find(isDiagramAttachment) ?? view.attachments[0]
      scene = await fetchBlobScene(att)
    }
  } catch {
    scene = null
  }
  if (scene === null) return
  if (mode === 'live') {
    // `boardId` is this message's id, so the session says what it grew out of.
    const { collaborateOn } = await import('./collab')
    collaborateOn({ conv: view.conv, title, scene, boardId: view.id })
    return
  }
  useStore.getState().openDiagramEditor({
    conv: view.conv,
    mode,
    title: mode === 'edit' ? `${title} (copy)` : title,
    scene,
    replyTo: mode === 'edit' ? view.id : undefined,
  })
}

/**
 * Export straight off the tile — no need to open the viewer first. The heavy
 * renderer is imported on the click, not on the render.
 */
function TileExport({ view, title, onError }: { view: MessageView; title: string; onError: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async (kind: 'png' | 'svg' | 'excalidraw'): Promise<void> => {
    setOpen(false)
    setBusy(true)
    try {
      const d = view.body.diagram
      if (!d) return
      const json = d.data
        ? await decodeScene(d.data)
        : await fetchBlobScene(view.attachments.find(isDiagramAttachment) ?? view.attachments[0])
      if (json === null) {
        onError()
        return
      }
      const stem = diagramFileStem(title)
      if (kind === 'excalidraw') {
        await window.bridge.files.saveBytesAs(
          `${stem}${DIAGRAM.ext}`,
          bytesToBase64(new TextEncoder().encode(json)),
          DIAGRAM.mime,
        )
        return
      }
      const { loadScene, sceneToPngBlob, sceneToSvg } = await import('./render')
      const scene = loadScene(json)
      if (kind === 'png') {
        const blob = await sceneToPngBlob(scene)
        await window.bridge.files.saveBytesAs(
          `${stem}.png`,
          bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
          'image/png',
        )
      } else {
        const svg = await sceneToSvg(scene)
        await window.bridge.files.saveBytesAs(
          `${stem}.svg`,
          bytesToBase64(new TextEncoder().encode(svg.outerHTML)),
          'image/svg+xml',
        )
      }
    } catch {
      onError()
    } finally {
      setBusy(false)
    }
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        style={linkBtn}
        title="Save this diagram as a file"
      >
        Export ▾
      </button>
      {open && (
        <>
          {/* Spans the shell's drag strip, so it has to opt out of it — see
              app/overlayChrome.ts. */}
          <span style={{ ...NO_DRAG, position: 'fixed', inset: 0, zIndex: 1 }} onMouseDown={() => setOpen(false)} />
          <span
            role="menu"
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 6,
              zIndex: 2,
              minWidth: 170,
              padding: 4,
              display: 'block',
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-md)',
              boxShadow: 'var(--elev-3)',
            }}
          >
            {(
              [
                ['png', 'PNG image'],
                ['svg', 'SVG (vector)'],
                ['excalidraw', `Scene (${DIAGRAM.ext})`],
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                role="menuitem"
                onClick={() => void run(kind)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '5px 8px',
                  border: 'none',
                  borderRadius: 'var(--r-sm)',
                  background: 'transparent',
                  color: 'var(--text-1)',
                  fontSize: 12.5,
                  fontFamily: 'var(--font-ui)',
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  )
}
