import { create } from 'zustand'
import type {
  BootMode,
  ChannelView,
  CursorView,
  GroupView,
  HealthView,
  LaunchInfo,
  PushMessage,
  SendDraft,
  SettingsView,
  BeamOfferView,
  BeamProgressView,
  BlobFetchState,
  UpdateView,
} from '@shared/bridge'
import type { ConvId, PresenceView, PrsStatus, PrView, VerifiedEvent } from '@shared/types'
import { TEAM_CONV } from '@shared/constants'
import { toast } from '@/app/toasts'
import type { DiagramEditorState } from '@/diagram/state'
import { endBoardIn, foldBoardEvents, type LiveBoardMap } from '@/diagram/live'
import type { PendingJump } from '@/search/jump'
import { findGroupRemovedEvent, resolveActiveConvVanish } from './convVanish'
import { noteLiveEvent, resetLiveEvents } from './liveEvents'
import { teamRenameNotice } from './teamRename'

// Central renderer state. Raw events per conversation live here; components
// materialize views with @shared/merge (memoized). All mutations go through
// bridge calls; pushes from main flow into this store.

export interface TypingMap {
  [deviceId: string]: number // until (share-clock ms)
}

/**
 * The Settings modal's left nav. Lives here rather than in the component
 * because the modal is opened from three places now — the sidebar gear, the
 * notifications popover ("All notification settings…") and the launch nudge —
 * and only the last of those can reach the component's own state (1.4).
 */
export type SettingsSection =
  | 'profile'
  // 1.5 — the admin panel: the team name (team-wide) and the always-online
  // toggle (personal). Listed in the nav only for an admin — `isGil`,
  // @shared/gilMode — and the rename it offers is refused on the share side
  // for anybody else (main/services/teamSettings.ts).
  | 'admin'
  | 'appearance'
  | 'notifications'
  | 'privacy'
  | 'quickMessages'
  | 'storage'
  | 'about'

interface ChatStore {
  boot: BootMode | null
  /**
   * A sentence the unlock screen shows above its passphrase field, set when
   * something sent the user back there. Today that is exactly one thing:
   * onboarding refusing to set up over local data this machine already holds
   * and nobody has unlocked ('locked-profile' — see AppController.onboardSubmit).
   */
  unlockNotice: string | null
  channels: ChannelView[]
  /** Private groups this device belongs to (1.2) — full replace on every `groups` push. */
  groups: GroupView[]
  /**
   * Bumped on every `channels`/`groups` push. `loadTeam()` fetches its own
   * snapshot of each list across an await; if a fresher push lands while that
   * fetch is in flight, the counter moves and `loadTeam()` drops its (now
   * stale) result for that slice instead of clobbering the push that beat it.
   */
  channelsSeq: number
  groupsSeq: number
  /**
   * Bumped every time the team folder goes away (the `boot` → 'onboarding'
   * push), which is the moment every cached log stops being true. `ensureEvents`
   * captures it before its read and drops the answer if it moved — otherwise a
   * `chat.events` call issued for the *old* folder lands afterwards and re-seeds
   * `events`, `eventsLoaded` and `liveBoards` with a conversation that is no
   * longer reachable (complete with Join buttons for boards on a share we left).
   * Same guard `channelsSeq`/`groupsSeq` have had since 1.2.
   */
  teamSeq: number
  /** Everyone else on the team folder — never this device (see `selfPresence`). */
  presence: PresenceView[]
  /**
   * 1.4 — this device's own row, which `presence` deliberately excludes (every
   * list that walks it is a list of other people). Null until the session is
   * up; the footer's status line and presence dot read it.
   */
  selfPresence: PresenceView | null
  events: Record<string, VerifiedEvent[]> // conv -> raw events (sorted on insert)
  eventsLoaded: Record<string, boolean>
  typing: Record<string, TypingMap>
  cursors: Record<string, Record<string, CursorView>>
  myReads: Record<string, string> // conv -> my read stem (local mirror)
  health: HealthView
  outboxQueued: number
  activeConv: ConvId | null
  settings: SettingsView | null
  /** 1.4 — the Settings modal: which section it is open on, or null when it is closed. */
  settingsSection: SettingsSection | null
  /** 1.4 — login-item + notification-support facts, for LaunchNudge and Settings. */
  launchInfo: LaunchInfo | null
  /**
   * 1.4 — "Not now" on the launch nudge. Store state rather than the card's
   * own `useState` so it survives an AppShell remount: the ask was one
   * suggestion *per launch*, and a remount is not a new launch. Nothing
   * persists it, so a real restart brings the card back.
   */
  launchNudgeDismissed: boolean
  beamOffers: BeamOfferView[]
  beamProgress: Record<string, BeamProgressView>
  blobs: Record<string, BlobFetchState>
  update: UpdateView | null
  lightbox: { conv: ConvId; eventId: string; blobId: string } | null
  /** The full-window diagram editor (1.2); null when it is closed — nothing is loaded until it isn't. */
  diagramEditor: DiagramEditorState | null
  /** OS fullscreen for the main window (1.3), mirrored from the `fullscreen` push. */
  fullscreen: boolean
  /**
   * Live boards (1.3), keyed by session id: folded from the `board-live` /
   * `board-ended` sys events of every conversation whose log is loaded. This
   * is what puts a **Join** button on a sys row and takes it away again.
   */
  liveBoards: LiveBoardMap
  /**
   * A "take me to that message" request from the quick switcher's message
   * search (1.6): set with the conversation, consumed by that conversation's
   * MessageList once its log is in, then cleared. Rules in search/jump.ts.
   */
  pendingJump: PendingJump | null
  /** Tracked Azure DevOps pull requests (pushed by the main-side PR service). */
  prs: PrView[]
  prsStatus: PrsStatus | null
  /** The PR group's settings dialog — opened from the pane header or the sidebar row. */
  prsPrefsOpen: boolean

  init(): Promise<void>
  /**
   * Leave onboarding for the unlock screen, carrying the reason. The boot mode
   * comes from main (it knows whether the seal is passphrase-wrapped or beyond
   * any build's reach); if it can't be reached, land on the passphrase card
   * anyway — being sent here at all means this profile is sealed and locked.
   */
  showUnlockScreen(notice: string): Promise<void>
  /** Everything team-scoped: channels, people, own read marks; then every log for badges. */
  loadTeam(): Promise<void>
  setActiveConv(conv: ConvId | null): void
  /** Navigate to the PR group and open (or close) its settings dialog. */
  setPrsPrefsOpen(open: boolean): void
  ensureEvents(conv: ConvId): Promise<void>
  /**
   * Open a conversation and scroll to one message in it (1.6). The log is
   * pulled first — the request is only worth anything to a MessageList that
   * can already see whether the message is there.
   */
  jumpToMessage(conv: ConvId, id: string): Promise<void>
  /** The jump has been acted on (scrolled to, or reported missing). */
  clearPendingJump(): void
  /** Resolves with the new event's id — a live board's `end` records the snapshot it finished on. */
  send(conv: ConvId, draft: SendDraft): Promise<{ id: string }>
  markRead(conv: ConvId, stem: string): void
  unreadCount(conv: ConvId): number
  openLightbox(v: { conv: ConvId; eventId: string; blobId: string } | null): void
  /** Open (or, with null, close) the diagram editor overlay. */
  openDiagramEditor(v: DiagramEditorState | null): void
  /** A live board is over — the host ended it, or a join found no directory. */
  markBoardEnded(sessionId: string): void
  refreshSettings(): Promise<void>
  /** 1.4 — open the Settings modal, optionally straight on one of its sections. */
  openSettings(section?: SettingsSection): void
  closeSettings(): void
  /** 1.4 — re-read after setOpenAtLogin or testNotification change the OS state. */
  refreshLaunchInfo(): Promise<void>
  /** 1.4 — "Not now": hide the launch nudge for the rest of this launch. */
  dismissLaunchNudge(): void
}

/**
 * Live-board frame deliveries bypass the store's state and go straight to the
 * open editor.
 *
 * They arrive up to once a second, carry a whole scene each, and exactly one
 * component ever wants them; putting them through zustand would re-render the
 * app shell for every stroke somebody else draws, and a listener that had to
 * re-subscribe (new session id) would drop the frames in between. The
 * registry above — which sessions exist — *is* ordinary state.
 */
type BoardPush = Extract<PushMessage, { kind: 'board-frames' } | { kind: 'board-ended' }>

const boardListeners = new Set<(msg: BoardPush) => void>()

export function onBoardPush(fn: (msg: BoardPush) => void): () => void {
  boardListeners.add(fn)
  return () => {
    boardListeners.delete(fn)
  }
}

function insertEvent(list: VerifiedEvent[], ev: VerifiedEvent): VerifiedEvent[] {
  if (list.some((e) => e.id === ev.id)) return list
  const next = [...list, ev]
  next.sort((a, b) => (a.id < b.id ? -1 : 1))
  return next
}

/**
 * After a `channels`/`groups` push lands, check whether the *active*
 * conversation just disappeared from under the user (deleted, or this device
 * left/was removed from a group) and, if so, land on the fixed channel and
 * say why. Pure decision lives in convVanish.ts; this just wires it to the
 * store and the toast rail.
 */
function checkConvVanish(get: () => ChatStore, prevChannels: ChannelView[], prevGroups: GroupView[]) {
  const cur = get()
  if (cur.activeConv === null) return
  const selfId = cur.boot?.mode === 'ready' ? cur.boot.self.deviceId : ''
  let events = cur.events[cur.activeConv] ?? []
  // A group's own log never carries the `group-removed` notice that would
  // explain why *this* device lost it (it travels, DM-sealed, over the
  // owner's DM instead — GrpPayload's comment) — if the vanished conv was a
  // group, look for that notice in whatever other conv's cache already holds
  // it (the 'event' push for it lands before the 'groups' push that triggers
  // this check, so by now it's there if it's coming at all).
  const wasGroup = prevGroups.find((g) => g.conv === cur.activeConv)
  if (wasGroup) {
    const removed = findGroupRemovedEvent(cur.events, wasGroup.groupId)
    if (removed && !events.some((e) => e.id === removed.id)) {
      events = [...events, removed].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }
  }
  const result = resolveActiveConvVanish({
    activeConv: cur.activeConv,
    channels: cur.channels,
    groups: cur.groups,
    prevChannels,
    prevGroups,
    events,
    selfDeviceId: selfId,
    nameOf: (d) => cur.presence.find((p) => p.deviceId === d)?.name ?? (d.slice(0, 8) || 'unknown'),
  })
  if (!result) return
  cur.setActiveConv(result.target)
  toast(result.toastText, 'info')
}

export const useStore = create<ChatStore>((set, get) => ({
  boot: null,
  unlockNotice: null,
  channels: [],
  groups: [],
  channelsSeq: 0,
  groupsSeq: 0,
  teamSeq: 0,
  presence: [],
  selfPresence: null,
  events: {},
  eventsLoaded: {},
  typing: {},
  cursors: {},
  myReads: {},
  health: { reachable: true, latencyMs: null },
  outboxQueued: 0,
  activeConv: null,
  settings: null,
  settingsSection: null,
  launchInfo: null,
  launchNudgeDismissed: false,
  beamOffers: [],
  beamProgress: {},
  blobs: {},
  update: null,
  lightbox: null,
  diagramEditor: null,
  fullscreen: false,
  liveBoards: {},
  pendingJump: null,
  prs: [],
  prsStatus: null,
  prsPrefsOpen: false,

  async init() {
    window.bridge.onPush((msg: PushMessage) => {
      const s = get()
      switch (msg.kind) {
        case 'boot':
          // The notice belongs to one visit to the unlock screen; anything
          // that moves the boot mode off 'locked' has answered it.
          set({ boot: msg.boot, unlockNotice: msg.boot.mode === 'locked' ? s.unlockNotice : null })
          if (msg.boot.mode === 'ready') {
            // Unlock / onboarding land here: same default as a cold start.
            void get().loadTeam()
          } else if (msg.boot.mode === 'onboarding') {
            // Team disconnect (folder change): drop all team-scoped state.
            // The dock badge is cleared from here, not from PrAlert's effect:
            // this same render unmounts AppShell (and PrAlert with it), so an
            // effect keyed on the unseen count never gets to write the 0.
            void window.bridge.app.setBadge(0).catch(() => {})
            // Event ids belong to the team that just went away.
            resetLiveEvents()
            set({
              teamSeq: s.teamSeq + 1,
              channels: [],
              groups: [],
              presence: [],
              selfPresence: null,
              events: {},
              eventsLoaded: {},
              typing: {},
              cursors: {},
              myReads: {},
              activeConv: null,
              beamOffers: [],
              beamProgress: {},
              blobs: {},
              update: null,
              lightbox: null,
              diagramEditor: null,
              liveBoards: {},
              pendingJump: null,
              outboxQueued: 0,
              prs: [],
              prsStatus: null,
              prsPrefsOpen: false,
            })
          }
          break
        case 'event': {
          // This is the only place where "this event is new to me" is still
          // knowable: every log is prefetched at boot, so by the time a pane
          // opens its contents say nothing about when they arrived. The easter
          // eggs (1.5) ask this afterwards; see store/liveEvents.ts.
          noteLiveEvent(msg.event.id)
          const liveBoards = foldBoardEvents(s.liveBoards, [msg.event])
          set({
            events: { ...s.events, [msg.conv]: insertEvent(s.events[msg.conv] ?? [], msg.event) },
            ...(liveBoards === s.liveBoards ? {} : { liveBoards }),
          })
          // 1.5 — "Ana renamed the team to X". The `team` push below carries
          // the new name but not who set it (PushMessage shapes are frozen),
          // and the renamer must not be told about their own rename, so the
          // notice is built from the event itself.
          //
          // Only once this log has been pulled, though: main replays every
          // team event through this push as it catches the log up at session
          // start — and on macOS every launch goes through the unlock screen,
          // i.e. through a session start with this window already listening.
          // A rename from last month is not news.
          const notice = s.eventsLoaded[msg.conv]
            ? teamRenameNotice({
                conv: msg.conv,
                event: msg.event,
                selfDeviceId: s.boot?.mode === 'ready' ? s.boot.self.deviceId : '',
                nameOf: (d) => s.presence.find((p) => p.deviceId === d)?.name ?? d.slice(0, 8),
              })
            : null
          if (notice) toast(notice, 'info')
          break
        }
        // 1.5 — the folded team name changed (main is the authority on which
        // `team-renamed` won). SelfView is where every surface reads it from.
        case 'team':
          if (s.boot?.mode === 'ready') {
            set({ boot: { mode: 'ready', self: { ...s.boot.self, teamName: msg.teamName } } })
          }
          break
        // Live boards (1.3): frames go straight to the open editor (see
        // onBoardPush); only the end of a session is state anybody else cares
        // about.
        case 'board-frames':
          for (const fn of boardListeners) fn(msg)
          break
        case 'board-ended':
          for (const fn of boardListeners) fn(msg)
          set({ liveBoards: endBoardIn(s.liveBoards, msg.sessionId) })
          break
        case 'channels': {
          const prevChannels = s.channels
          set({ channels: msg.channels, channelsSeq: s.channelsSeq + 1 })
          checkConvVanish(get, prevChannels, s.groups)
          break
        }
        case 'groups': {
          const prevGroups = s.groups
          set({ groups: msg.groups, groupsSeq: s.groupsSeq + 1 })
          checkConvVanish(get, s.channels, prevGroups)
          break
        }
        case 'presence':
          set({ presence: msg.views })
          break
        // 1.4 — our own row, off the local beacon: the status the footer shows
        // and the dot next to our avatar.
        case 'self-presence':
          set({ selfPresence: msg.view })
          break
        case 'typing': {
          const conv = s.typing[msg.conv] ?? {}
          set({ typing: { ...s.typing, [msg.conv]: { ...conv, [msg.deviceId]: msg.until } } })
          break
        }
        case 'cursors': {
          const conv = s.cursors[msg.conv] ?? {}
          set({ cursors: { ...s.cursors, [msg.conv]: { ...conv, [msg.deviceId]: msg.cursor } } })
          break
        }
        case 'health':
          // `offsetMs` is only present when main has calibrated against the
          // folder, and the push that says "unreachable" carries none — so the
          // last known offset is kept rather than thrown away, because an
          // unreachable share does not make the clocks agree again.
          set({
            health:
              msg.health.offsetMs === undefined && s.health.offsetMs !== undefined
                ? { ...msg.health, offsetMs: s.health.offsetMs }
                : msg.health,
          })
          break
        case 'outbox':
          set({ outboxQueued: msg.queued })
          break
        case 'beam-offer':
          set({ beamOffers: [...s.beamOffers.filter((o) => o.dropId !== msg.offer.dropId), msg.offer] })
          break
        case 'beam-progress':
          set({ beamProgress: { ...s.beamProgress, [msg.progress.dropId]: msg.progress } })
          break
        case 'blob':
          set({ blobs: { ...s.blobs, [msg.state.blobId]: msg.state } })
          break
        case 'update':
          set({ update: msg.update })
          break
        case 'prs':
          set({ prs: msg.prs, prsStatus: msg.status })
          break
        case 'prs-open':
          get().setActiveConv(TEAM_CONV.prs)
          break
        case 'fullscreen':
          set({ fullscreen: msg.on })
          break
        case 'skew-warning':
          break
      }
    })

    const boot = await window.bridge.app.getBoot()
    set({ boot })
    const settings = await window.bridge.settings.get()
    set({ settings })
    // 1.4 — OS-level facts, not team-scoped: safe to read regardless of boot
    // mode, same as settings above.
    set({ launchInfo: await window.bridge.app.launchInfo() })
    if (boot.mode === 'ready') await get().loadTeam()
  },

  async showUnlockScreen(notice: string) {
    // Main is the authority on *which* unlock card (a passphrase the user
    // has, versus a seal no build can open) — but not on whether to show one:
    // it only ever refuses onboarding when this profile is sealed and locked.
    const boot = await window.bridge.app.getBoot().catch(() => null)
    set({
      unlockNotice: notice,
      boot: boot?.mode === 'locked' ? boot : { mode: 'locked', reason: 'passphrase' },
    })
  },

  async loadTeam() {
    // A `channels`/`groups` push can land from the main process while these
    // awaits are in flight (e.g. a `channel-deleted` sys event arriving right
    // after boot). Capture the sequence counters *before* each fetch so a
    // push that beat the fetch back is detected, not clobbered by the older
    // snapshot this function requested first.
    const channelsSeqAtStart = get().channelsSeq
    const [channels, presence, myReads, selfPresence] = await Promise.all([
      window.bridge.chat.channels(),
      window.bridge.presence.list(),
      window.bridge.chat.myReads(),
      // Our own row (1.4). Pulled as well as pushed: main's 'self-presence'
      // push goes out while the session starts, which is before this window is
      // listening on a cold launch. Tolerant of a preload without it — the
      // push then fills the footer in a moment later.
      Promise.resolve(window.bridge.presence.self?.() ?? null).catch(() => null),
    ])
    set((s) => ({
      channels: s.channelsSeq === channelsSeqAtStart ? channels : s.channels,
      presence,
      myReads,
      selfPresence: selfPresence ?? s.selfPresence,
    }))
    const liveChannels = get().channels
    if (liveChannels.length && !get().activeConv) get().setActiveConv(liveChannels[0].conv)
    // Private groups (1.2): best-effort — until the main-side handlers land,
    // groups:list rejects 'not-implemented' and the sidebar just shows none.
    const groupsSeqAtStart = get().groupsSeq
    try {
      const groups = await window.bridge.groups.list()
      set((s) => (s.groupsSeq === groupsSeqAtStart ? { groups } : {}))
    } catch (err) {
      if (!/not-implemented/.test(String(err))) console.warn('groups: initial load failed', err)
    }
    // Unread badges need every conversation's log, not just the open one; the
    // team logs (calendar, PR config) ride the same prefetch so the sidebar can
    // show a "something today" dot without opening the pane.
    for (const conv of [
      ...get().channels.map((c) => c.conv),
      ...presence.map((p) => p.dmConv),
      ...get().groups.map((g) => g.conv),
      ...Object.values(TEAM_CONV),
    ])
      void get().ensureEvents(conv)
    // The PR service starts right after the chat service; a 'not-ready' here
    // just means we raced it and the first 'prs' push will fill the slice in.
    // Anything else is a real failure worth seeing in the console.
    try {
      const [prsStatus, prs] = await Promise.all([window.bridge.prs.status(), window.bridge.prs.list()])
      set({ prs, prsStatus })
    } catch (err) {
      if (!/not-ready/.test(String(err))) console.warn('prs: initial load failed', err)
    }
  },

  setActiveConv(conv) {
    // Leaving the PR group unmounts PrsPane — and the prefs modal with it —
    // without going through the modal's own close paths, so the flag has to be
    // dropped here or the next visit to team:prs opens the settings dialog
    // over the list unbidden.
    set(conv === TEAM_CONV.prs ? { activeConv: conv } : { activeConv: conv, prsPrefsOpen: false })
    if (conv) void get().ensureEvents(conv)
  },

  setPrsPrefsOpen(open) {
    if (open) get().setActiveConv(TEAM_CONV.prs)
    set({ prsPrefsOpen: open })
  },

  async ensureEvents(conv) {
    if (get().eventsLoaded[conv]) return
    // `loadTeam` fires one of these per conversation and none of them is
    // cancellable, so a folder switch mid-flight has to be detected on the way
    // back: see `teamSeq`.
    const teamSeqAtStart = get().teamSeq
    const list = await window.bridge.chat.events(conv)
    if (get().teamSeq !== teamSeqAtStart) return
    list.sort((a, b) => (a.id < b.id ? -1 : 1))
    set((s) => ({
      events: { ...s.events, [conv]: list },
      eventsLoaded: { ...s.eventsLoaded, [conv]: true },
      // A session announced while this client was away is only discoverable
      // here: the catch-up read is the first time its `board-live` is seen.
      liveBoards: foldBoardEvents(s.liveBoards, list),
    }))
    const cursors = await window.bridge.chat.cursors(conv)
    if (get().teamSeq !== teamSeqAtStart) return
    set((s) => ({ cursors: { ...s.cursors, [conv]: cursors } }))
  },

  async jumpToMessage(conv, id) {
    // Order matters: the field is set *before* the conversation switches, so a
    // MessageList that is already mounted on `conv` (searching from inside the
    // conversation you are reading) sees the request on the same render the
    // switch would otherwise have been the only trigger for.
    set({ pendingJump: { conv, id } })
    get().setActiveConv(conv)
    await get().ensureEvents(conv)
  },

  clearPendingJump() {
    set({ pendingJump: null })
  },

  async send(conv, draft) {
    return window.bridge.chat.send(conv, draft)
  },

  markRead(conv, stem) {
    const prev = get().myReads[conv] ?? ''
    if (stem <= prev) return
    set((s) => ({ myReads: { ...s.myReads, [conv]: stem } }))
    void window.bridge.chat.markRead(conv, stem)
  },

  unreadCount(conv) {
    const s = get()
    const read = s.myReads[conv] ?? ''
    const events = s.events[conv] ?? []
    const selfId = s.boot?.mode === 'ready' ? s.boot.self.deviceId : ''
    return events.filter((e) => e.type === 'msg' && e.id > read && e.author !== selfId).length
  },

  openLightbox(v) {
    set({ lightbox: v })
  },

  openDiagramEditor(v) {
    set({ diagramEditor: v })
  },

  markBoardEnded(sessionId) {
    set((s) => ({ liveBoards: endBoardIn(s.liveBoards, sessionId) }))
  },

  async refreshSettings() {
    set({ settings: await window.bridge.settings.get() })
  },

  openSettings(section = 'profile') {
    set({ settingsSection: section })
  },

  closeSettings() {
    set({ settingsSection: null })
  },

  async refreshLaunchInfo() {
    set({ launchInfo: await window.bridge.app.launchInfo() })
  },

  dismissLaunchNudge() {
    set({ launchNudgeDismissed: true })
  },
}))

export function selfOf(boot: BootMode | null) {
  return boot?.mode === 'ready' ? boot.self : null
}
