// MUST be the first import: it arms window.EXCALIDRAW_ASSET_PATH before
// Excalidraw's font registry is evaluated, which is the difference between
// self-hosted fonts and a blocked CDN request. See assets.ts.
import './assets'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw, FONT_FAMILY, exportToBlob, exportToSvg, loadFromBlob, restoreLibraryItems, serializeAsJSON } from '@excalidraw/excalidraw'
import type { BinaryFiles, ExcalidrawImperativeAPI, LibraryItems } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import { DIAGRAM } from '@shared/constants'
import { DIAGRAM_DEFAULT_TITLE, cleanTitle, diagramFileStem } from '@shared/diagram'
import { useStore } from '@/store'
import { Spinner } from '@/ui/atoms'
import { ConfirmDialog } from '@/app/ChannelMenu'
import { DRAG, NO_DRAG, overlayChromeInsets } from '@/app/chrome'
import { IconCollapse, IconExpand } from '@/app/icons'
import { CloseIcon, DownloadIcon } from '@/content/icons'
import { LiveCloseDialog, LiveControls, LiveEndedBanner, LiveHint } from './LiveChrome'
import { escapeAction, type CanvasEscapeState } from './escape'
import { initialAppState } from './style'
import { clearDraft, draftRestorable, draftSlotOf, readDraft, writeDraft } from './drafts'
import { useLiveBoard } from './useLiveBoard'
import { fullScreenKeyLabel, isFullScreenToggleKey } from './fullscreenKey'
import { fetchBundledLibraries, libraryPayload } from './libraries'
import { bytesToBase64, planDiagramSend, sceneSignature } from './scene'
import { sanitizeScene } from './sanitize'
import type { DiagramEditorState } from './state'

// The full-window diagram editor (1.2). Same overlay grammar as the media
// lightbox — fixed inset 0, its own chrome strip, Esc closes — but it owns the
// keyboard while it is up, because Excalidraw's own shortcuts live underneath.
//
// This module is the lazy chunk: importing it pulls in Excalidraw. Nothing may
// import it statically except DiagramRoot's `lazy()`.

const SAVE_DEBOUNCE_MS = 800

type Busy = null | 'sending' | 'exporting' | 'importing'

export default function DiagramEditor({ slot }: { slot: DiagramEditorState }) {
  const settings = useStore((s) => s.settings)
  const channels = useStore((s) => s.channels)
  const groups = useStore((s) => s.groups)
  const send = useStore((s) => s.send)
  const fullscreen = useStore((s) => s.fullscreen)
  const close = useCallback(() => useStore.getState().openDiagramEditor(null), [])

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const [title, setTitle] = useState(() => slot.title || DIAGRAM_DEFAULT_TITLE)
  const [busy, setBusy] = useState<Busy>(null)
  const [note, setNote] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  /** Set once the close confirm is up; `kept` is whether the draft really made it to disk. */
  const [closing, setClosing] = useState<{ kept: boolean } | null>(null)
  const dirty = useRef(false)
  /** Fingerprint of the element array as of the last real edit — see `scheduleSave`. */
  const sig = useRef('')
  const saveTimer = useRef<number | null>(null)
  /**
   * Did *this editor* put the window in fullscreen? Only then does closing it
   * take the window back out — see the unmount effect below.
   */
  const weWentFs = useRef(false)
  /** Set by the first toggle, so the mount-time reconcile cannot overwrite it. */
  const fsAsked = useRef(false)

  /** Every fullscreen request the editor makes goes through here, intent included. */
  const setFullScreen = useCallback((on: boolean) => {
    fsAsked.current = true
    weWentFs.current = on
    void window.bridge.app.setFullScreen(on).catch(() => {})
  }, [])

  // "New diagram here", "edit a copy of that message" and a live board are
  // different pieces of unsent work; they used to share one draft key per
  // conversation, so opening the second silently overwrote the first — and a
  // live board published it to everyone. See drafts.ts.
  const slotKey = draftSlotOf(slot)
  /** A live board's slot: its draft is written but never reopened (see drafts.ts). */
  const liveSlot = !draftRestorable(slot)

  const viewOnly = slot.mode === 'view'
  const theme = settings?.theme === 'light' ? 'light' : 'dark'
  // How far the header's content has to stay clear of the OS's own window
  // controls — the macOS traffic lights sit *on top* of this overlay, which is
  // why the title input used to be printed under them (1.4 tester report).
  const insets = overlayChromeInsets(window.bridge.platform, fullscreen)

  const convLabel = useMemo(() => {
    const ch = channels.find((c) => c.conv === slot.conv)
    if (ch) return `#${ch.name}`
    const g = groups.find((x) => x.conv === slot.conv)
    if (g) return `🔒 ${g.name}`
    return 'this conversation'
  }, [channels, groups, slot.conv])

  const flash = useCallback((msg: string) => {
    setNote(msg)
    window.setTimeout(() => setNote((n) => (n === msg ? null : n)), 3200)
  }, [])

  // Live mode (1.3). The hook owns the session; everything below only asks it
  // whether there is one. `bannerOff` is the dismissal of the "host ended it"
  // notice, not the session's state — the hook keeps that.
  const live = useLiveBoard({ apiRef, slot, title, viewOnly, flash })
  /** Stable across renders (the hook memoizes it), so `scheduleSave` can depend on it. */
  const isRemoteEcho = live.isRemoteEcho
  const [bannerOff, setBannerOff] = useState(false)
  /** The host's three-way close, and the host's "…and end the session" after a Send. */
  const [liveClosing, setLiveClosing] = useState(false)
  const [endAfterSend, setEndAfterSend] = useState<{ stem: string } | null>(null)

  // ---------------------------------------------------------------- initial
  // Resolved once (the component is keyed on the slot, so a new diagram is a
  // new mount): this slot's autosaved draft, else the scene it was opened with.
  /** True when a draft replaced the scene the editor was opened with — say so, once. */
  const restoredDraft = useRef(false)
  const initialData = useMemo(() => {
    // An unsent draft for THIS slot wins over the scene the slot was opened
    // with: it is the newer version of the same work, and the close dialog
    // promised it would come back. Never for a live board, though — a joiner's
    // scene comes from the session's frames and a host's from the diagram they
    // clicked Collaborate on (see `draftRestorable`).
    const restored = viewOnly || !draftRestorable(slot) ? null : readDraft(slot.conv, slotKey)
    const json = restored?.scene ?? slot.scene ?? null
    if (restored && !slot.title) setTitle(restored.title || DIAGRAM_DEFAULT_TITLE)
    const parsed = json ? safeParse(json) : null
    const elements = (parsed?.elements ?? []) as ExcalidrawElement[]
    sig.current = sceneSignature(elements)
    restoredDraft.current = restored !== null && slot.scene !== null
    return {
      elements,
      // A brand-new canvas opens clean — straight 1 px strokes, Nunito, no
      // pencil (1.4, see style.ts). A scene that arrived with its own appState
      // keeps every value it brought, key by key.
      appState: initialAppState(parsed?.appState, FONT_FAMILY.Nunito),
      files: (parsed?.files ?? {}) as BinaryFiles,
      scrollToContent: true,
      libraryItems: loadBundledLibraryItems(),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (restoredDraft.current) flash('Restored your unsent draft of this diagram')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------- autosave
  /** Write the draft right now; `false` means it could not be kept (too big, or no quota). */
  const saveDraftNow = useCallback((): boolean => {
    const api = apiRef.current
    if (!api) return false
    return writeDraft(slot.conv, slotKey, {
      title,
      scene: serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local'),
    })
  }, [slot.conv, slotKey, title])

  //
  // `onChange` fires for everything Excalidraw does — pan, zoom, pick a tool,
  // move the pointer with one armed — so it cannot mean "edited". Only a change
  // in the element array itself counts; without that, closing a diagram nobody
  // touched asked "are you sure?". A call with no elements (the title input) is
  // always an edit.
  const scheduleSave = useCallback(
    (elements?: readonly { version?: number; versionNonce?: number }[]) => {
      if (viewOnly) return
      if (elements) {
        const next = sceneSignature(elements)
        if (next === sig.current) return
        sig.current = next
        // A peer's stroke arriving on a live board is not unsent work of ours:
        // it must neither arm the "you have unsaved work" confirm nor spend a
        // localStorage write. Without this, somebody who only watched a board
        // was asked about losing a drawing they never touched.
        if (isRemoteEcho(next)) return
      }
      dirty.current = true
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(saveDraftNow, SAVE_DEBOUNCE_MS)
    },
    [isRemoteEcho, saveDraftNow, viewOnly],
  )

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      // The E2E handle set on the Excalidraw callback below: a stale API for a
      // canvas that is gone would answer questions about nothing.
      delete (window as unknown as { __sfDiagramApi?: unknown }).__sfDiagramApi
    },
    [],
  )

  const tryClose = useCallback(() => {
    // Hosting a running board is the one close that costs other people
    // something, so it asks first — End for everyone, or leave it running.
    // A guest just leaves (the hook's unmount gives up their frame file).
    if (live.session?.isHost) {
      setLiveClosing(true)
      return
    }
    if (viewOnly || !dirty.current) {
      close()
      return
    }
    // Save first, then say what actually happened. The old wording promised the
    // work was kept even when the draft was too big for localStorage to hold —
    // which is exactly the case where the person needed to be told.
    setClosing({ kept: saveDraftNow() })
  }, [close, live.session, saveDraftNow, viewOnly])

  // Esc closes the editor's own chrome — but NOT when the canvas has it.
  //
  // Excalidraw owns Escape inside its host: it leaves a text element being
  // typed, drops a selection, closes the shape-library panel. Swallowing it at
  // the window's capture phase meant every one of those tore the whole editor
  // down instead (behind a confirm, on top of unsent work). So: the confirm
  // first, then the export menu, then — only if the event did not come from
  // inside `.excalidraw` — the editor itself.
  //
  // F11 / ⌃⌘F (1.3) does NOT follow that rule: the canvas is where the pointer
  // is for the whole time anybody wants to go fullscreen, and Excalidraw claims
  // ⌃⌘F for its own element search, so bailing on `.excalidraw` targets meant
  // the chord opened a search panel on macOS and F11 did nothing at all. This
  // listener is on the window in the capture phase, so stopping the event here
  // is what keeps it away from Excalidraw's own handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isFullScreenToggleKey(e, window.bridge.platform)) {
        e.stopPropagation()
        e.preventDefault()
        setFullScreen(!fullscreen)
        return
      }
      if (e.key !== 'Escape') return
      if (closing) {
        setClosing(null)
        e.stopPropagation()
        e.preventDefault()
        return
      }
      // The live dialogs run their own Escape (they have three answers, not
      // two) — this handler must not also read it as "close the editor".
      if (liveClosing || endAfterSend) return
      if (exportOpen) {
        setExportOpen(false)
        e.stopPropagation()
        return
      }
      // Inside the canvas Escape used to be Excalidraw's unconditionally
      // (outside fullscreen), which meant an idle canvas swallowed it and the
      // header's Close button was the only way out — and in 1.3 that button
      // was under the window's drag strip, so there was no way out at all.
      // Since 1.4 it escalates: Excalidraw keeps it only while it has
      // something of its own to cancel (a text edit, a dialog, a menu, a
      // selection, an armed tool), then fullscreen, then the editor. See
      // escape.ts for the rule and its tests.
      const target = e.target as Element | null
      const fromCanvas = !!target?.closest?.('.excalidraw')
      const action = escapeAction(fromCanvas ? canvasEscapeState(apiRef.current) : null, fullscreen)
      if (action === 'excalidraw') return
      e.stopPropagation()
      e.preventDefault()
      // Esc leaves fullscreen first — a second Esc then closes the editor, same
      // two-step as a confirm dialog swallowing the first Esc above.
      if (action === 'exit-fullscreen') {
        setFullScreen(false)
        return
      }
      tryClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closing, endAfterSend, exportOpen, fullscreen, liveClosing, setFullScreen, tryClose])

  // Closing the editor — however it happens (the header's Close button, a
  // successful Send, the close-confirm dialog) — leaves OS fullscreen behind
  // too: nobody wants the ordinary chat UI pinned edge-to-edge with the window
  // chrome gone once the thing that asked for fullscreen is no longer up.
  // Driven by unmount rather than by patching every close path, so it still
  // holds for whatever live-session leave/end flow lands on top of `close`
  // later.
  //
  // What it follows is this editor's *intent* (`weWentFs`), not the store's
  // `fullscreen` flag, for two reasons. The flag is a push from the main
  // process and arrives a beat after the request, so closing the editor during
  // the transition left the window fullscreen forever; and it is equally true
  // of a window the person had put fullscreen themselves before ever opening a
  // diagram, which closing the editor then yanked out from under them.
  useEffect(
    () => () => {
      if (weWentFs.current) void window.bridge.app.setFullScreen(false).catch(() => {})
    },
    [],
  )

  // Was the window already fullscreen when this editor opened? Then it is not
  // ours to undo. Asked of the window itself rather than of the store, whose
  // flag only exists once a transition has been pushed.
  useEffect(() => {
    void window.bridge.app
      .isFullScreen()
      .then((on) => {
        if (on && !fsAsked.current) weWentFs.current = false
      })
      .catch(() => {})
  }, [])

  // ----------------------------------------------------------------- send
  const doSend = useCallback(async () => {
    const api = apiRef.current
    if (!api || busy) return
    const elements = api.getSceneElements()
    if (elements.length === 0) {
      flash('Nothing to send — the canvas is empty')
      return
    }
    setBusy('sending')
    try {
      const appState = api.getAppState()
      const files = api.getFiles()
      const json = serializeAsJSON(elements, appState, files, 'local')
      const png = await exportToBlob({
        elements: elements as NonDeletedExcalidrawElement[],
        appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
        files,
        mimeType: 'image/png',
        maxWidthOrHeight: 1024,
      })
      const bounds = boundsOf(elements)
      const plan = await planDiagramSend(
        title,
        { json, png, w: bounds.w, h: bounds.h, elements: elements.length },
        { replyTo: slot.replyTo },
      )
      const sent = await send(slot.conv, plan.draft)
      clearDraft(slot.conv, slotKey)
      dirty.current = false
      // While a board is live, Send is a snapshot of where the drawing has got
      // to — not the end of it. The editor stays up and the frames keep
      // flowing; the host is then asked whether that snapshot was the finish.
      if (live.session) {
        setBusy(null)
        if (live.session.isHost) setEndAfterSend({ stem: sent.id })
        else flash(`Sent to ${convLabel} — the board is still live`)
        return
      }
      close()
    } catch (err) {
      const msg = String(err)
      flash(
        msg.includes('queued')
          ? 'Queued — it will send when the folder is back'
          : msg.includes('diagram-too-large')
            ? 'This diagram is too big to send — try splitting it'
            : 'Could not send the diagram',
      )
      setBusy(null)
    }
  }, [busy, close, convLabel, flash, live.session, send, slot.conv, slot.replyTo, slotKey, title])

  // --------------------------------------------------------------- export
  const doExport = useCallback(
    async (kind: 'png' | 'svg' | 'excalidraw') => {
      const api = apiRef.current
      setExportOpen(false)
      if (!api || busy) return
      setBusy('exporting')
      try {
        const elements = api.getSceneElements()
        const appState = api.getAppState()
        const files = api.getFiles()
        const stem = diagramFileStem(title)
        if (kind === 'excalidraw') {
          const json = serializeAsJSON(elements, appState, files, 'local')
          await save(`${stem}${DIAGRAM.ext}`, new TextEncoder().encode(json), DIAGRAM.mime)
        } else if (kind === 'png') {
          const blob = await exportToBlob({
            elements: elements as NonDeletedExcalidrawElement[],
            appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
            files,
            mimeType: 'image/png',
          })
          await save(`${stem}.png`, new Uint8Array(await blob.arrayBuffer()), 'image/png')
        } else {
          const svg = await exportToSvg({
            elements: elements as NonDeletedExcalidrawElement[],
            appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
            files,
          })
          await save(`${stem}.svg`, new TextEncoder().encode(svg.outerHTML), 'image/svg+xml')
        }
      } catch (err) {
        flash(String(err).includes('not-implemented') ? 'File service lands in the next build' : 'Export failed')
      } finally {
        setBusy(null)
      }
    },
    [busy, flash, title],
  )

  // --------------------------------------------------------------- import
  const applyFile = useCallback(
    async (name: string, base64: string): Promise<void> => {
      const api = apiRef.current
      if (!api) return
      const loaded = await loadSceneFile(name, base64)
      api.updateScene({ elements: loaded.elements, appState: { ...api.getAppState(), ...loaded.appState } })
      if (loaded.files) api.addFiles(Object.values(loaded.files))
      if (!slot.title) setTitle(cleanTitle(name.replace(/\.(excalidraw|png|svg)$/i, '')))
      scheduleSave()
    },
    [scheduleSave, slot.title],
  )

  const importFailed = useCallback(
    (err: unknown) =>
      flash(
        String(err).includes('file-too-large')
          ? 'That file is too big to import'
          : 'That file does not carry an Excalidraw scene',
      ),
    [flash],
  )

  const doImport = useCallback(async () => {
    if (!apiRef.current || busy) return
    setBusy('importing')
    try {
      const picked = await window.bridge.files.pickFile({
        title: 'Import a diagram',
        filters: [
          { name: 'Diagrams', extensions: ['excalidraw', 'png', 'svg'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      if (!picked) return
      await applyFile(picked.name, picked.bytes)
    } catch (err) {
      importFailed(err)
    } finally {
      setBusy(null)
    }
  }, [applyFile, busy, importFailed])

  // A drop or an "Import diagram…" from the composer hands the editor its file
  // up front; the Excalidraw API only exists after the first render, so this
  // waits for the mount rather than doing it in the initial data.
  const autoRan = useRef(false)
  useEffect(() => {
    if (autoRan.current) return
    autoRan.current = true
    if (slot.importFile) {
      void applyFile(slot.importFile.name, slot.importFile.base64).catch(importFailed)
    } else if (slot.autoImport) {
      void doImport()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------------ view
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={viewOnly ? `Diagram: ${title}` : `Diagram editor: ${title}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'var(--bg-app)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        // THE drag strip while the editor is up (1.4). The shell's own
        // TitleBar is still in the DOM underneath, and Chromium builds the
        // draggable region from the DOM regardless of z-order — so the top
        // 36 px of this overlay was draggable no matter what it painted there,
        // and every control in it was dead to a real mouse (CDP clicks go
        // straight to the DOM, which is why the E2E never saw it). The fix is
        // to own the region rather than fight it: the strip drags the window,
        // every interactive thing in it is NO_DRAG, and the content is inset
        // past the OS's own controls (overlayChrome.ts).
        style={{
          ...DRAG,
          // Full screen (1.3): the header collapses to a slim 36px strip —
          // title, the Live pill slot, the fullscreen toggle, Send, Close —
          // and the canvas below gets the rest of the window. Windowed it is
          // 52, comfortably over the shell strip's 36.
          height: fullscreen ? 36 : 52,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: (fullscreen ? 8 : 16) + insets.left,
          paddingRight: (fullscreen ? 8 : 12) + insets.right,
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-panel)',
          userSelect: 'none',
        }}
      >
        {!fullscreen && (
          <span aria-hidden style={{ fontSize: 15 }}>
            📐
          </span>
        )}
        <input
          value={title}
          readOnly={viewOnly}
          onChange={(e) => {
            setTitle(e.target.value)
            scheduleSave()
          }}
          aria-label="Diagram title"
          placeholder={DIAGRAM_DEFAULT_TITLE}
          style={{
            ...NO_DRAG,
            width: 260,
            padding: '5px 8px',
            border: '1px solid transparent',
            borderRadius: 'var(--r-sm)',
            background: viewOnly ? 'transparent' : 'var(--bg-input)',
            color: 'var(--text-1)',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'var(--font-ui)',
            outline: 'none',
          }}
        />
        {/* Live boards (1.3): "Start live session" until there is one, then
            the Live pill with everyone drawing, and the host's End. Kept in
            its own module so this header stays one line. */}
        <span className="sem-live-pill-slot" style={{ ...NO_DRAG, display: 'inline-flex', minWidth: 0 }}>
          <LiveControls live={live} viewOnly={viewOnly} suppressStart={live.ended && !bannerOff} />
        </span>
        <span style={{ flex: 1 }} />

        {/* The slim fullscreen header shows it too: these notices are the only
            word anybody gets about a frame that was refused or a send that
            queued, and in fullscreen there is nowhere else for them to go. */}
        {note && (
          <span
            style={{
              ...NO_DRAG,
              fontSize: 12,
              color: 'var(--warning)',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {note}
          </span>
        )}

        {!fullscreen && (
          <div style={{ ...NO_DRAG, position: 'relative' }}>
            <button
              onClick={() => setExportOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
              title="Export this diagram to a file"
              style={chromeBtn}
            >
              <DownloadIcon size={13} />
              Export ▾
            </button>
            {exportOpen && (
              <>
                {/* The click-away backdrop spans the window from inside a
                    drag strip, so it has to opt out too — otherwise dismissing
                    the menu anywhere near the top started a window drag. */}
                <div style={{ ...NO_DRAG, position: 'fixed', inset: 0, zIndex: 1 }} onMouseDown={() => setExportOpen(false)} />
                <div
                  role="menu"
                  className="sem-popover"
                  style={{
                    ...NO_DRAG,
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: 6,
                    zIndex: 2,
                    minWidth: 190,
                    padding: 4,
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
                      onClick={() => void doExport(kind)}
                      style={menuItem}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover, var(--bg-panel))')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {!fullscreen && !viewOnly && (
          <button onClick={() => void doImport()} title="Open a .excalidraw file (or an image with a scene)" style={chromeBtn}>
            Import…
          </button>
        )}

        <button
          onClick={() => setFullScreen(!fullscreen)}
          aria-pressed={fullscreen}
          aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
          title={fullScreenKeyLabel(window.bridge.platform)}
          style={{ ...chromeBtn, padding: '0 8px' }}
        >
          {fullscreen ? <IconCollapse size={14} /> : <IconExpand size={14} />}
        </button>

        {!viewOnly && (
          <button
            onClick={() => void doSend()}
            disabled={busy !== null}
            title={`Send this diagram to ${convLabel}`}
            style={{
              ...chromeBtn,
              border: '1px solid var(--accent)',
              background: 'var(--accent)',
              color: 'var(--on-accent)',
              opacity: busy !== null ? 0.6 : 1,
            }}
          >
            {busy === 'sending' ? <Spinner size={12} /> : null}
            Send to {convLabel}
          </button>
        )}

        {/* Spelled out rather than a bare ×: this is the way out of a
            full-window mode, and a tester who could not find it had no way
            back to the conversation at all (1.4). Esc does the same thing —
            see escape.ts for when the canvas keeps the key instead. */}
        <button
          onClick={tryClose}
          title="Close the diagram editor (Esc)"
          aria-label="Close the diagram editor"
          style={{ ...chromeBtn, padding: '0 10px' }}
        >
          <CloseIcon size={14} />
          Close
        </button>
      </header>

      {/* Said once per app session, the first time a board goes live. */}
      {live.session && <LiveHint convLabel={convLabel} />}

      {live.ended && !bannerOff && <LiveEndedBanner onDismiss={() => setBannerOff(true)} />}

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }} className="sem-diagram-host">
        <Excalidraw
          excalidrawAPI={(api) => {
            apiRef.current = api
            // A read-only handle for scripts/e2e-drive.mjs (and the dev
            // console): the canvas's real app state — did Excalidraw actually
            // adopt the clean defaults? — is otherwise unreachable from
            // outside this component, and `serializeAsJSON` deliberately drops
            // the `currentItem*` keys, so the autosaved draft cannot answer it.
            // Nothing in the app reads this back; the unmount below clears it.
            ;(window as unknown as { __sfDiagramApi?: unknown }).__sfDiagramApi = api
          }}
          initialData={initialData}
          onChange={(elements) => {
            scheduleSave(elements)
            // Live boards (1.3): the same call decides whether anything worth
            // sharing changed. It re-reads the scene rather than using these
            // elements — see the echo guard in useLiveBoard.
            live.onSceneChange()
          }}
          onPointerUpdate={live.onPointerUpdate}
          isCollaborating={live.session !== null}
          theme={theme}
          viewModeEnabled={viewOnly}
          name={title}
          UIOptions={{
            canvasActions: {
              // Everything that would leave the app or hit the network: the
              // header above owns saving, and there is no cloud here.
              saveToActiveFile: false,
              loadScene: false,
              export: false,
              saveAsImage: false,
              toggleTheme: false,
            },
          }}
          autoFocus
          detectScroll={false}
        />
      </div>

      {closing && (
        // Above the editor's own 1100 (it lives inside this overlay's stacking
        // context, so this only has to beat Excalidraw's internal layers).
        <ConfirmDialog
          title={liveSlot ? 'Close this board?' : 'Close this diagram?'}
          message={
            // A live board's draft is never reopened (see drafts.ts), so this
            // must not promise that it is: what was drawn while the board was
            // live is already with everyone who was on it, and the copy in this
            // window is not coming back.
            liveSlot
              ? 'Anything you drew while the board was live is already with everybody who was on it. This window’s copy is not reopened later — send it to the conversation if you want it kept.'
              : closing.kept
                ? 'Your unsent work is kept as a draft — opening the diagram from this conversation again brings it straight back.'
                : 'This drawing could not be saved as a draft (it is too large, or the local store is full), so closing it now loses the unsent work.'
          }
          confirmLabel={liveSlot || closing.kept ? 'Close' : 'Close and lose it'}
          tone={liveSlot || closing.kept ? 'primary' : 'danger'}
          zIndex={1200}
          onConfirm={() => {
            setClosing(null)
            close()
          }}
          onClose={() => setClosing(null)}
        />
      )}

      {liveClosing && (
        <LiveCloseDialog
          participants={live.participants.length}
          busy={live.busy !== null}
          onEnd={() => {
            setLiveClosing(false)
            saveDraftNow()
            // Closed only once the board really ended: a refused `end` leaves
            // the session running, and walking out of the editor on the
            // strength of a request that failed is how a host ends up believing
            // they shut down a board that everyone else is still drawing on.
            void live.end().then((ended) => {
              if (ended) close()
            })
          }}
          onLeave={() => {
            // The hook's unmount is what gives up this device's frame file, so
            // "keep it running" is simply a close.
            setLiveClosing(false)
            saveDraftNow()
            close()
          }}
          onCancel={() => setLiveClosing(false)}
        />
      )}

      {endAfterSend && (
        <ConfirmDialog
          title={`Sent to ${convLabel}`}
          message="That snapshot is now in the conversation. The live board is still running — end it for everyone, or keep drawing."
          confirmLabel="End the session"
          tone="primary"
          zIndex={1200}
          onConfirm={() => {
            // `board-ended` carries the snapshot's event id, so the notice can
            // point at the version the board finished on.
            const stem = endAfterSend.stem
            setEndAfterSend(null)
            void live.end(stem).then((ended) => {
              if (ended) close()
            })
          }}
          onClose={() => setEndAfterSend(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

// Every header control spreads this, so the `no-drag` opt-out (1.4) rides
// along with it — a new button added to that strip cannot forget it and end up
// unclickable under the window's drag region.
const chromeBtn: React.CSSProperties = {
  ...NO_DRAG,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
  padding: '0 10px',
  flexShrink: 0,
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--bg-raised)',
  color: 'var(--text-1)',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'var(--font-ui)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const menuItem: React.CSSProperties = {
  ...NO_DRAG,
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 8px',
  border: 'none',
  borderRadius: 'var(--r-sm)',
  background: 'transparent',
  color: 'var(--text-1)',
  fontSize: 13,
  fontFamily: 'var(--font-ui)',
  cursor: 'pointer',
}

/**
 * The bits of Excalidraw's app state that decide who owns Escape — the whole
 * input to `escapeAction` (escape.ts), and the only place this file touches
 * those field names.
 *
 * `null` when there is no canvas yet: then nothing inside it can be claiming
 * the key, and Escape is the editor's.
 */
function canvasEscapeState(api: ExcalidrawImperativeAPI | null): CanvasEscapeState | null {
  const st = api?.getAppState()
  if (!st) return null
  return {
    editingText: !!st.editingTextElement,
    dialogOpen: !!st.openDialog,
    // Menus, the colour popovers and the shape-library sidebar all dismiss on
    // Escape, and all of them are things a person opened on purpose.
    menuOpen: !!st.openMenu || !!st.openPopup || !!st.openSidebar || !!st.contextMenu,
    hasSelection: Object.keys(st.selectedElementIds ?? {}).length > 0,
    // A drawing tool is armed: Escape puts the pointer back, it does not close
    // the window somebody was about to draw in.
    activeTool: st.activeTool?.type ?? 'selection',
    editing: !!st.editingLinearElement || !!st.croppingElementId,
  }
}

/**
 * Parse a scene the editor was opened with. Peer-authored documents come
 * through here too ("Open", "Edit a copy"), so it goes through the same
 * sanitizer the tile uses: `files[]` entries pointing at a remote URL are
 * dropped (they would be fetched the moment the canvas drew them) and an
 * absurd element count is refused. Links are NOT stripped here — inside the
 * editor a link is Excalidraw's own feature and a click leaves through
 * `shell.openExternal` like any other message link.
 *
 * `null` on anything unparseable: the editor opens blank rather than crashing.
 */
function safeParse(json: string): { elements?: unknown; appState?: Record<string, unknown>; files?: unknown } | null {
  try {
    return sanitizeScene(JSON.parse(json))
  } catch {
    return null
  }
}

function boundsOf(elements: readonly { x: number; y: number; width: number; height: number; isDeleted?: boolean }[]): {
  w: number
  h: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of elements) {
    if (el.isDeleted) continue
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.width)
    maxY = Math.max(maxY, el.y + el.height)
  }
  if (!Number.isFinite(minX)) return { w: 420, h: 320 }
  return { w: Math.max(1, Math.round(maxX - minX)) + 24, h: Math.max(1, Math.round(maxY - minY)) + 24 }
}

/** The bundled starter shapes, merged across files and version formats. */
async function loadBundledLibraryItems(): Promise<LibraryItems> {
  const raws = await fetchBundledLibraries()
  const out: LibraryItems[number][] = []
  for (const raw of raws) {
    try {
      out.push(...restoreLibraryItems(libraryPayload(raw) as never, 'published'))
    } catch {
      // one malformed library must not cost the others
    }
  }
  return out
}

/**
 * Turn picked bytes into a scene. `.excalidraw` is the certain case; a PNG or
 * SVG only works when it was exported with "embed scene", and Excalidraw's own
 * loader is what knows how to dig the payload back out of either.
 */
async function loadSceneFile(name: string, base64: string) {
  const lower = name.toLowerCase()
  const mime = lower.endsWith('.png')
    ? 'image/png'
    : lower.endsWith('.svg')
      ? 'image/svg+xml'
      : DIAGRAM.mime
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const blob = new Blob([bytes as BlobPart], { type: mime })
  return loadFromBlob(blob, null, null)
}

async function save(name: string, bytes: Uint8Array, mime: string): Promise<void> {
  await window.bridge.files.saveBytesAs(name, bytesToBase64(bytes), mime)
}
