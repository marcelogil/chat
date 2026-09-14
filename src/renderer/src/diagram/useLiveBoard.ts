import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaptureUpdateAction, reconcileElements, restoreElements } from '@excalidraw/excalidraw'
import type { BinaryFileData, Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BoardFrameDraft, ConvId } from '@shared/types'
import { BOARD } from '@shared/constants'
import { onBoardPush, useStore } from '@/store'
import type { LiveSyncStats } from './liveStatus'
import { sceneSignature } from './scene'
import {
  digestFrames,
  keepPending,
  markSent,
  newFileTracker,
  pruneParticipants,
  sceneChanged,
  selectNewFiles,
  type LiveParticipant,
  type ParticipantMap,
} from './live'
import type { DiagramEditorState } from './state'

// Live mode for the diagram editor (1.3): the wiring between Excalidraw's
// imperative API and the `boards.*` bridge. Imports Excalidraw, so it lives
// behind the lazy boundary with DiagramEditor and nowhere else; every decision
// it makes that can be decided without a canvas is in `live.ts`, next to its
// tests.
//
// Outbound: a real scene change (signature compare, same fingerprint the
// autosave uses) writes the *whole* element list; a pointer move writes a
// pointer-only frame — no elements, no files — no more than four times a
// second. Main coalesces both down to BOARD.writeMinMs / pointerMinMs and
// publishes one file per participant.
//
// Inbound: each delivery is reconciled with Excalidraw's own per-element
// last-writer-wins (`reconcileElements`) and applied with
// `CaptureUpdateAction.NEVER`, so a peer's edit never lands in this user's
// undo stack. The signature of what we just applied is then recorded as our
// own, which is the echo guard: the `onChange` Excalidraw fires for that very
// `updateScene` compares equal and writes nothing back.

/** Our own pointer writes; main throttles again, this just keeps the IPC quiet. */
const POINTER_MIN_MS = 250

/**
 * A pointer frame carries no elements, so main's coalescer can keep a
 * pointer-only draft and drop the scene draft it superseded inside the same
 * write window — and then the last stroke of an edit sits in nobody's canvas
 * but ours. One scene frame follows a burst of pointer moves to close that
 * window; when nothing was lost, main sees an unchanged content signature and
 * writes nothing at all.
 */
const CONTENT_CATCHUP_MS = BOARD.writeMinMs * 2

/**
 * The wire shape of an outbound draft. `elements` is deliberately absent from a
 * pointer-only frame — shipping the whole element list four times a second is
 * what made an oversized scene flash on every peer's canvas — and main already
 * reads it as optional (`contentSignature` does `draft.elements ?? []`), while
 * the contract type still spells it required.
 */
type OutboundDraft = Omit<BoardFrameDraft, 'elements'> & { elements?: unknown[] }

export interface LiveSession {
  sessionId: string
  host: string
  /** True when this device published the `board-live` event. */
  isHost: boolean
}

export interface LiveBoard {
  session: LiveSession | null
  /** Set once the host ended the board: the scene stays, the writes stop. */
  ended: boolean
  busy: 'starting' | 'joining' | 'ending' | null
  /** Everyone whose frame landed inside BOARD.staleMs, self excluded. */
  participants: LiveParticipant[]
  start: () => void
  join: (sessionId: string, host?: string) => void
  /**
   * Host only: `board-ended` for everyone, then the dir goes. Resolves with
   * whether it actually happened — a caller that closes the editor afterwards
   * must not do so when the board is still running.
   */
  end: (resultStem?: string) => Promise<boolean>
  /** Called from the editor's own `onChange`, after the draft autosave. */
  onSceneChange: () => void
  onPointerUpdate: (payload: { pointer: { x: number; y: number; tool: 'pointer' | 'laser' } }) => void
  /**
   * True when this scene signature is exactly what a remote frame just put on
   * the canvas — i.e. the `onChange` it is about to cause is a peer's work, not
   * this user's. The editor asks before it calls a change "unsaved work": a
   * guest who only watched must not be handed a draft-loss confirm on close.
   */
  isRemoteEcho: (signature: string) => boolean
  /**
   * What the Live pill says about the traffic (1.4). Read from refs on a
   * one-second tick in the pill rather than pushed through state: a board being
   * drawn on writes several frames a second, and re-rendering the whole editor
   * header that often to move a word is not worth a frame of canvas latency.
   */
  syncStats: () => LiveSyncStats
}

export function useLiveBoard(opts: {
  apiRef: React.MutableRefObject<ExcalidrawImperativeAPI | null>
  slot: DiagramEditorState
  title: string
  viewOnly: boolean
  flash: (msg: string) => void
}): LiveBoard {
  const { apiRef, slot, viewOnly, flash } = opts
  const conv: ConvId = slot.conv
  const selfDevice = useStore((s) => (s.boot?.mode === 'ready' ? s.boot.self.deviceId : ''))
  // A frame's `name` is whatever the writer put in it. The roster this device
  // already trusts wins where it knows the device: a display name is how people
  // are told apart on the board, and it is not a field worth taking on trust.
  const presence = useStore((s) => s.presence)
  // Is the share answering at all? The pill says "Reconnecting…" on this
  // directly — a board cannot be in sync over a folder that is not there.
  const reachable = useStore((s) => s.health.reachable)

  const [session, setSession] = useState<LiveSession | null>(null)
  const [ended, setEnded] = useState(false)
  const [busy, setBusy] = useState<'starting' | 'joining' | 'ending' | null>(null)
  const [participants, setParticipants] = useState<ParticipantMap>({})

  // Refs the push handler and the throttles read: they must see the current
  // value without re-subscribing (a re-subscribe drops frames).
  const sessionRef = useRef<LiveSession | null>(null)
  const titleRef = useRef(opts.title)
  titleRef.current = opts.title
  /** Signature of the scene as this device last saw it — the echo guard. */
  const liveSig = useRef('')
  /** Signature of the last scene a *remote* frame put on the canvas (see `isRemoteEcho`). */
  const remoteSig = useRef('')
  const files = useRef(newFileTracker())
  const pointer = useRef<{ x: number; y: number; tool: 'pointer' | 'laser' } | undefined>(undefined)
  const lastPointerWrite = useRef(0)
  /** When a frame carrying elements last went out — the catch-up's whole condition. */
  const lastContentWrite = useRef(0)
  const contentCatchUp = useRef<number | null>(null)
  /** `frame-too-large` is one notice per session, not one per second. */
  const tooLargeSaid = useRef(false)
  const participantsRef = useRef<ParticipantMap>({})

  // ---- What the pill reports (1.4). Refs, not state: see `syncStats` below.
  /** `Date.now()` when main last *accepted* a write of ours. */
  const sentAt = useRef(0)
  /** `Date.now()` when a peer's frame was last applied to this canvas. */
  const recvAt = useRef(0)
  /** Writes started but not yet settled, and when the oldest of them began. */
  const inFlight = useRef(0)
  const pendingSince = useRef<number | null>(null)

  const setSessionBoth = useCallback((s: LiveSession | null) => {
    sessionRef.current = s
    setSession(s)
  }, [])

  /**
   * The session is over for this device: keep the scene, stop writing, say so.
   * Reached from the `board-ended` push and from a `write` that main refused
   * because the session had already ended (the push can be the slower of the
   * two, and an editor that keeps writing into a dead session is a zombie).
   */
  const goLocal = useCallback(
    (sessionId: string) => {
      if (!sessionRef.current || sessionRef.current.sessionId !== sessionId) return
      sessionRef.current = null
      setSession(null)
      setEnded(true)
      participantsRef.current = {}
      setParticipants({})
      useStore.getState().markBoardEnded(sessionId)
    },
    [],
  )

  // -------------------------------------------------------------- outbound
  /**
   * One frame. `elements` omitted = a pointer-only frame: the cursor and the
   * selection, nothing else. Those go out four times a second, and a whole
   * element list at that rate is what made a big scene flash on every peer's
   * canvas (invisible to the person causing it, since their own canvas never
   * reconciles).
   */
  const writeFrame = useCallback(
    (elements?: readonly unknown[]) => {
      const live = sessionRef.current
      const api = apiRef.current
      if (!live || !api) return
      const now = Date.now()
      const draft: OutboundDraft = {
        pointer: pointer.current,
        selectedIds: Object.keys(api.getAppState().selectedElementIds ?? {}),
      }
      if (elements) {
        draft.elements = [...elements]
        lastContentWrite.current = now
        // Files only ride a frame that carries the elements using them.
        const fresh = selectNewFiles(files.current, api.getFiles() as unknown as Record<string, unknown>, now)
        if (fresh) draft.files = fresh
      }
      // "Sending…" in the pill is exactly this: a write main has not answered
      // yet. Counted rather than flagged, because pointer frames and scene
      // frames overlap freely.
      inFlight.current += 1
      if (pendingSince.current === null) pendingSince.current = now
      const settled = (): void => {
        inFlight.current = Math.max(0, inFlight.current - 1)
        if (inFlight.current === 0) pendingSince.current = null
      }
      void window.bridge.boards
        .write(live.sessionId, conv, draft as BoardFrameDraft)
        .then((res: unknown) => {
          // Accepted by main — the folder is answering.
          sentAt.current = Date.now()
          // Files main had to drop to fit `BOARD.maxFrameBytes` never reached
          // the share: put them back in the outgoing set rather than letting
          // the element that needs them be a blank on every peer's canvas.
          // (Older main processes resolve `undefined` — nothing was dropped.)
          const dropped = (res as { droppedFiles?: unknown } | undefined)?.droppedFiles
          if (Array.isArray(dropped) && dropped.length > 0) keepPending(files.current, dropped as string[], Date.now())
        })
        .catch((err: unknown) => {
          const msg = String(err)
          if (msg.includes('board-ended')) goLocal(live.sessionId)
          else if (msg.includes('frame-too-large')) {
            if (tooLargeSaid.current) return
            tooLargeSaid.current = true
            flash('That scene is too big to share live — the others keep the last frame that fitted')
          } else if (msg.includes('not-implemented')) flash('Live boards land in the next build')
        })
        .finally(settled)
    },
    [apiRef, conv, flash, goLocal],
  )

  const onSceneChange = useCallback(() => {
    const api = apiRef.current
    if (!sessionRef.current || !api) return
    // Read the scene back rather than trusting `onChange`'s argument: the echo
    // guard compares against what a reconcile put on the canvas, and both
    // sides of that comparison have to be counted the same way (tombstones
    // included).
    const elements = api.getSceneElementsIncludingDeleted()
    const next = sceneSignature(elements)
    if (!sceneChanged(liveSig.current, next)) return
    liveSig.current = next
    // A real scene frame makes the catch-up redundant.
    if (contentCatchUp.current !== null) {
      window.clearTimeout(contentCatchUp.current)
      contentCatchUp.current = null
    }
    writeFrame(elements)
  }, [apiRef, writeFrame])

  const onPointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number; tool: 'pointer' | 'laser' } }) => {
      if (!sessionRef.current) return
      // Scene coordinates, straight from Excalidraw and straight onto the wire:
      // translating them through this window's scroll or zoom is how a remote
      // cursor ends up drawn somewhere the sender never pointed.
      pointer.current = { x: payload.pointer.x, y: payload.pointer.y, tool: payload.pointer.tool }
      const now = Date.now()
      if (now - lastPointerWrite.current < POINTER_MIN_MS) return
      lastPointerWrite.current = now
      // Pointer only — no elements, no files (see OutboundDraft).
      writeFrame()
      // …and, only when a scene frame from the last write window could have been
      // the one this just replaced, one scene frame after the moving stops (see
      // CONTENT_CATCHUP_MS). Moving the cursor around a scene nobody is editing
      // costs nothing extra, which is the whole point of a pointer-only frame.
      if (contentCatchUp.current !== null || now - lastContentWrite.current >= BOARD.writeMinMs) return
      contentCatchUp.current = window.setTimeout(() => {
        contentCatchUp.current = null
        const api = apiRef.current
        if (sessionRef.current && api) writeFrame(api.getSceneElementsIncludingDeleted())
      }, CONTENT_CATCHUP_MS)
    },
    [apiRef, writeFrame],
  )

  // --------------------------------------------------------------- inbound
  const applyFrames = useCallback(
    (incoming: Parameters<typeof digestFrames>[0]) => {
      const api = apiRef.current
      if (!api) return
      const now = Date.now()
      // Anything at all coming back means the poll is alive — the pill's
      // "Reconnecting…" is the absence of this for longer than a keepalive
      // round (liveStatus.ts).
      if (incoming.length > 0) recvAt.current = now
      const digest = digestFrames(incoming, { selfDevice, participants: participantsRef.current, now })

      if (digest.batches.length > 0) {
        let local = api.getSceneElementsIncludingDeleted()
        for (const batch of digest.batches) {
          // Through Excalidraw's own restorer before the reconciler sees it:
          // `live.ts` only knows that an element is an object with an id, while
          // `restoreElements` is what drops a type this build cannot draw,
          // de-duplicates ids, and repairs bindings whose other half did not
          // arrive (a bound arrow pointing at nothing crashes the renderer).
          // `refreshDimensions: false` — re-measuring text here would move the
          // writer's shapes on our canvas and nowhere else.
          const restored = restoreElements(batch.elements as Parameters<typeof restoreElements>[0], null, {
            refreshDimensions: false,
            repairBindings: true,
          })
          local = reconcileElements(
            local,
            restored as unknown as Parameters<typeof reconcileElements>[1],
            api.getAppState(),
          ) as unknown as readonly OrderedExcalidrawElement[]
        }
        // NEVER: a peer's stroke is not something this user can undo.
        api.updateScene({ elements: local, captureUpdate: CaptureUpdateAction.NEVER })
        // The echo guard — see the module comment. `remoteSig` is the half of it
        // the editor reads: this signature is a peer's work, not unsent work of
        // this user's.
        liveSig.current = sceneSignature(local)
        remoteSig.current = liveSig.current
      }

      const fresh = Object.entries(digest.files).filter(([id]) => !(id in api.getFiles()))
      if (fresh.length > 0) {
        api.addFiles(fresh.map(([, f]) => f as BinaryFileData))
        // Already on the share: never put them back on it.
        markSent(files.current, fresh.map(([id]) => id))
      }

      participantsRef.current = digest.participants
      setParticipants(digest.participants)
    },
    [apiRef, selfDevice],
  )

  /**
   * Who a device is. The roster (presence) first, the frame's own `name` only
   * where this device has never met the writer — a name is how people are told
   * apart on a shared canvas, and the frame's copy is self-declared.
   */
  const nameOf = useMemo(() => {
    const names = new Map<string, string>()
    for (const p of presence) if (p.name?.trim()) names.set(p.deviceId, p.name)
    return (device: string, fromFrame: string): string => names.get(device) ?? fromFrame
  }, [presence])

  // Excalidraw draws remote cursors from the collaborators map, keyed by what
  // it calls a socket id — here, the device id.
  useEffect(() => {
    const api = apiRef.current
    if (!api || !session) return
    const map = new Map<SocketId, Collaborator>()
    for (const p of Object.values(participants)) {
      map.set(p.device as SocketId, {
        id: p.device,
        username: nameOf(p.device, p.name),
        pointer: p.pointer,
        selectedElementIds: Object.fromEntries(p.selectedIds.map((id) => [id, true])),
        color: p.color,
      })
    }
    api.updateScene({ collaborators: map, captureUpdate: CaptureUpdateAction.NEVER })
  }, [apiRef, nameOf, participants, session])

  // A participant who stops writing (closed their editor, lost the share) has
  // to leave the pill on its own — no frame is coming to evict them.
  useEffect(() => {
    if (!session) return
    const t = window.setInterval(() => {
      const next = pruneParticipants(participantsRef.current, Date.now())
      if (next === participantsRef.current) return
      participantsRef.current = next
      setParticipants(next)
    }, 5000)
    return () => window.clearInterval(t)
  }, [session])

  // Subscribed once, for the life of the editor: the session id is read from a
  // ref so that starting or joining never has to re-subscribe (and drop the
  // frames that land in between).
  useEffect(
    () =>
      onBoardPush((msg) => {
        const live = sessionRef.current
        if (!live || msg.sessionId !== live.sessionId) return
        if (msg.kind === 'board-frames') {
          applyFrames(msg.frames)
          return
        }
        // Ended by the host (or the dir vanished): keep the scene, stop writing.
        goLocal(msg.sessionId)
      }),
    [applyFrames, goLocal],
  )

  // ------------------------------------------------------------- lifecycle
  const seedSignature = useCallback(() => {
    const api = apiRef.current
    liveSig.current = api ? sceneSignature(api.getSceneElementsIncludingDeleted()) : ''
  }, [apiRef])

  const start = useCallback(() => {
    if (viewOnly || sessionRef.current || busy) return
    setBusy('starting')
    void (async () => {
      try {
        const seededFrom = slot.live?.kind === 'start' ? slot.live.boardId : undefined
        const { sessionId } = await window.bridge.boards.start(conv, titleRef.current, seededFrom)
        const live: LiveSession = { sessionId, host: selfDevice, isHost: true }
        setSessionBoth(live)
        setEnded(false)
        tooLargeSaid.current = false
        // The host joins its own session: `join` is what starts the poller, so
        // without it the person who opened the board is the only one who never
        // sees anybody else's strokes.
        const { frames } = await window.bridge.boards.join(sessionId, conv)
        seedSignature()
        applyFrames(frames)
        // Publish the scene the board was seeded with, so a joiner who arrives
        // before the first edit still gets something to look at.
        const api = apiRef.current
        if (api) writeFrame(api.getSceneElementsIncludingDeleted())
      } catch (err) {
        setSessionBoth(null)
        flash(String(err).includes('not-implemented') ? 'Live boards land in the next build' : 'Could not open a live board')
      } finally {
        setBusy(null)
      }
    })()
  }, [applyFrames, busy, conv, flash, selfDevice, seedSignature, setSessionBoth, slot.live, viewOnly, writeFrame, apiRef])

  const join = useCallback(
    (sessionId: string, host?: string) => {
      if (sessionRef.current || busy) return
      setBusy('joining')
      void (async () => {
        try {
          const { frames } = await window.bridge.boards.join(sessionId, conv)
          // A `board-ended` that landed *while* the join was in flight was
          // dropped by the push handler (there was no session to match it
          // against yet), and main's poller has nothing left to notice: the
          // registry is the only record. Without this the editor sits in a
          // session nobody else is in, writing frames into a deleted directory.
          if (useStore.getState().liveBoards[sessionId]?.ended) {
            void window.bridge.boards.leave(sessionId, conv).catch(() => {})
            flash('That live board ended just as you joined')
            setEnded(true)
            return
          }
          setSessionBoth({ sessionId, host: host ?? '', isHost: host === selfDevice })
          setEnded(false)
          tooLargeSaid.current = false
          seedSignature()
          applyFrames(frames)
        } catch (err) {
          const msg = String(err)
          if (msg.includes('not-implemented')) flash('Live boards land in the next build')
          else {
            // No directory left to read: the session is over, whatever the sys
            // row still says. Mark it so the Join button stops offering it.
            useStore.getState().markBoardEnded(sessionId)
            flash('That live board has already ended')
            setEnded(true)
          }
        } finally {
          setBusy(null)
        }
      })()
    },
    [applyFrames, busy, conv, flash, selfDevice, seedSignature, setSessionBoth],
  )

  /**
   * Host only. The IPC comes first and the local session goes only if it
   * succeeded: dropping the session up front meant that a refused `end` (the
   * share gone, the dir already swept, a `not-host` from a session this device
   * did not start) left this editor out of a board that was still running for
   * everybody else — with no way back in and no sign anything had gone wrong.
   */
  const end = useCallback(
    async (resultStem?: string): Promise<boolean> => {
      const live = sessionRef.current
      if (!live) return false
      setBusy('ending')
      try {
        await window.bridge.boards.end(live.sessionId, conv, resultStem)
        // Ending it is also leaving it: the banner is the host's receipt.
        goLocal(live.sessionId)
        return true
      } catch {
        flash('Could not end the live board — it is still running')
        return false
      } finally {
        setBusy(null)
      }
    },
    [conv, flash, goLocal],
  )

  // Opened straight into a session (the tile's Collaborate, a sys row's Join).
  const armed = useRef(false)
  useEffect(() => {
    if (armed.current || !slot.live) return
    armed.current = true
    if (slot.live.kind === 'start') start()
    else join(slot.live.sessionId, slot.live.host)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Closing the editor gives up this device's frame file — otherwise a stale
  // pointer sits on everyone else's board for staleMs.
  //
  // `pagehide` is the other half: a reload (⌘R, a renderer crash-recovery) and
  // a window close tear the React tree down without running unmount effects, so
  // the file would be left behind for the janitor and the pointer would haunt
  // the board until it went stale. Main drops the session on its side too (the
  // window's `closed` handler), but a reload keeps the process alive, so this
  // one has to be said here as well. Fire-and-forget: the page is going.
  useEffect(() => {
    const leave = (): void => {
      const live = sessionRef.current
      if (!live) return
      sessionRef.current = null
      void window.bridge.boards.leave(live.sessionId, conv).catch(() => {})
    }
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      if (contentCatchUp.current !== null) window.clearTimeout(contentCatchUp.current)
      leave()
    }
  }, [conv])

  const list = useMemo(() => {
    const named = Object.values(participants).map((p) => ({ ...p, name: nameOf(p.device, p.name) }))
    return named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }, [nameOf, participants])

  const isRemoteEcho = useCallback((signature: string) => signature !== '' && signature === remoteSig.current, [])

  // Read through a ref so `syncStats` can stay identity-stable while still
  // seeing the current value (the pill calls it on its own tick).
  const reachableRef = useRef(reachable)
  reachableRef.current = reachable
  const syncStats = useCallback(
    (): LiveSyncStats => ({
      sentAt: sentAt.current,
      recvAt: recvAt.current,
      pendingSince: pendingSince.current,
      peers: Object.keys(participantsRef.current).length,
      reachable: reachableRef.current,
    }),
    [],
  )

  return {
    session,
    ended,
    busy,
    participants: list,
    start,
    join,
    end,
    onSceneChange,
    onPointerUpdate,
    isRemoteEcho,
    syncStats,
  }
}
