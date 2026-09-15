// The complete typed contract between renderer and main. The preload script
// implements exactly this shape; renderer code accesses it as window.bridge.
// FROZEN: UI and main-side services are built against these types in parallel.
// "Frozen" means no existing member changes shape. Whole new namespaces are
// additive and safe (1.1 added `calendar` and `prs`); editing one that already
// exists is not.

import type {
  AdoResult,
  BoardFrame,
  BoardFrameDraft,
  ConvId,
  Cursor,
  DiagramBody,
  PresenceView,
  VerifiedEvent,
  BodyEntity,
  CalendarEntry,
  LinkPreview,
  PollBody,
  PrView,
  PrsProbe,
  PrsRepo,
  PrsStatus,
  RtcSignal,
  TrustState,
} from './types'

// ---------------------------------------------------------------------------
// View models

export type BootMode =
  | { mode: 'onboarding'; sharePathSuggestion: string | null; savedName?: string | null }
  // 'passphrase': the local data is wrapped under the team passphrase — unlock
  // each launch (macOS always; Windows only without DPAPI).
  // 'unrecoverable': sealed by an OS keystore that can't open it any more —
  // the only way forward is app.resetLocalData().
  | { mode: 'locked'; reason: 'passphrase' | 'unrecoverable' }
  | { mode: 'ready'; self: SelfView }

export interface SelfView {
  deviceId: string
  displayName: string
  hostname: string // sanitized, for the chip
  fingerprint: string // "Q7RC-2MZE"
  teamName: string
  sharePath: string
  platform: 'darwin' | 'win32' | 'linux'
}

export interface ChannelView {
  conv: ConvId
  channelId: string
  name: string
  topic: string
  /** The team's home channel — can't be renamed or deleted (1.2). */
  fixed: boolean
}

export interface DmView {
  conv: ConvId
  peerDeviceId: string
}

/** A private group this device belongs to (1.2). */
export interface GroupView {
  conv: ConvId // grp:<groupId>
  groupId: string
  name: string
  owner: string // deviceId
  members: string[] // deviceIds, owner included, current epoch
  epoch: number
  role: 'owner' | 'member'
}

export interface HealthView {
  reachable: boolean
  latencyMs: number | null
  /**
   * Add this to `Date.now()` for the share clock (1.3, additive — absent when
   * main has not calibrated against the folder yet, and on older builds).
   *
   * The renderer needs it because deadlines travel in share time: a poll's
   * `closesAt` is restated on the share clock by main (`calibrateClosesAt`), so
   * a machine whose clock is an hour fast was closing polls an hour early —
   * locally, and only for the person with the wrong clock.
   */
  offsetMs?: number
}

export interface OnboardHealth {
  writable: boolean
  readBack: boolean
  latencyMs: number
  existingTeamName: string | null
}

export interface AttachDraft {
  path: string
  /** Renderer-generated inline thumbnail (data: URI ≤ 24KB) for media. */
  thumb?: string
  w?: number
  h?: number
  durMs?: number
}

export interface SendDraft {
  text: string
  kind: 'text' | 'code' | 'gif' | 'diagram' | 'poll'
  lang?: string | null
  packId?: string
  entities?: BodyEntity[]
  replyTo?: string
  /** Files to attach — uploaded to the blob store, then referenced. */
  attachments?: AttachDraft[]
  /** Pre-fetched link preview (composer fetches via bridge.links.preview). */
  linkPreview?: LinkPreview
  /** kind:'diagram' (1.2): the renderer-built scene; oversized scenes ride `attachments` instead. */
  diagram?: DiagramBody
  /** kind:'poll' (1.3). */
  poll?: PollBody
}

export type CursorView = Cursor

export interface BeamOfferView {
  dropId: string
  fromDeviceId: string
  name: string
  size: number
  mime: string
  note?: string
  thumb?: string
}

export interface BeamProgressView {
  dropId: string
  direction: 'send' | 'receive'
  peerDeviceId: string
  name: string
  size: number
  bytesDone: number
  transport: 'p2p' | 'folder'
  state: 'connecting' | 'waiting' | 'transferring' | 'saved' | 'declined' | 'failed' | 'canceled' | 'expired'
  savedPath?: string
}

export interface BlobFetchState {
  blobId: string
  state: 'idle' | 'downloading' | 'ready' | 'failed' | 'expired'
  bytesDone: number
  bytesTotal: number
  /** sfblob:// URL once ready (or progressively playable). */
  url: string | null
}

export interface ScreenSourceView {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnailDataUrl: string
  appIconDataUrl?: string
  /** The primary display — pre-selected in the picker (1.2). */
  primary?: boolean
}

export interface ScreenSessionView {
  sessionId: string
  presenterDevice: string
  conv: ConvId
  mode: 'p2p' | 'relay' | 'connecting' | 'ended'
  viewers: number
}

export interface UpdateView {
  version: string
  notes: string
  blocking: boolean
  /** 1.2: 'peer' when a teammate's beacon announced a newer build (absent = signed manifest). */
  source?: 'manifest' | 'peer'
  /** Who is already on `version` (source 'peer'). */
  peerName?: string
  /** False when no verified zip for `version` is in apps/ yet — the banner offers the folder instead of a copy. */
  zipAvailable?: boolean
}

/** Live share-traffic readout (1.2) — see IO_BUDGET. */
export interface ShareStats {
  sinceMs: number
  total: number
  /** Per primitive: readdir / read / stat / publish / delete. */
  byOp: Record<string, number>
  /** Logical ops in the trailing 60 s and the derived rate. */
  lastMinute: number
  ratePerSec: number
  tier: 'focused' | 'blurred' | 'idle' | 'paused'
}

export interface SettingsView {
  theme: 'system' | 'dark' | 'light'
  notifyChannels: 'all' | 'mentions' | 'none'
  notifyPreviews: boolean
  autoplayGifs: 'always' | 'hover' | 'never'
  autoAcceptBeams: boolean
  quietHours: { enabled: boolean; from: string; to: string }
  fontSize: 'S' | 'M' | 'L'
  /** 1.4 — the launch nudge: suggest "open at login" and "allow notifications" until both are accepted. */
  suggestAtLaunch?: boolean
  /** 1.4 — set when the person clicked "Turn on notifications" (best effort: the OS prompt cannot be read back). */
  notificationsAccepted?: boolean
  /** 1.5 — play the message easter eggs (a bug running across the window, confetti). Default on. */
  easterEggs?: boolean
  /** 1.5 — keep this device's presence green regardless of idle time or a locked screen (only offered to Gil). */
  alwaysOnline?: boolean
  /**
   * 1.4 — pull-request alerts: every tracked pull request, only the ones
   * waiting on me (next actor, assigned, or mine), or none at all. Never
   * touches the sidebar badge, which counts rather than interrupts.
   */
  notifyPrs?: 'all' | 'mine' | 'none'
  /**
   * 1.4 — direct messages and private groups. They ignore `notifyChannels` (you
   * were invited into them personally), so before this they had no switch at
   * all; absent means on, which is what every earlier version did.
   */
  notifyDms?: boolean
  /**
   * 1.4 — "pause everything" as a deadline in ms epoch. Silences every chat and
   * pull-request alert, OS and in-app, until it passes; null or a time already
   * gone reads as off. Beam offers are deliberately exempt — they expire
   * unanswered.
   */
  snoozeUntil?: number | null
  /**
   * Customized text for the composer's inline quick-reply chip row, one
   * message per entry in display order. Null or absent means the five
   * built-in defaults — see `effectiveQuickMessages` in
   * shared/quickMessages.ts, the one place both the row and the Settings →
   * Quick messages editor agree on that fallback (and on the per-entry/
   * list-length limits a save enforces).
   */
  quickMessages?: string[] | null
  /**
   * 1.4 — the status line under your name ("back at 3"). Plaintext, like every
   * other setting: it is already public on the share, every teammate's beacon
   * carries it. Persisted here because the beacon is memory only — before this
   * a relaunch silently cleared the status you set. Restored into the beacon
   * at session start (`restoredBeaconPresence`); absent means none.
   */
  status?: string
}

/** What the launch nudge needs to decide whether to show (1.4). */
export interface LaunchInfo {
  /** Whether the OS is set to open Chat at login, and whether this build/OS supports asking. */
  openAtLogin: boolean
  openAtLoginSupported: boolean
  /** Whether this launch came from the login item (macOS; always false elsewhere). */
  openedAtLogin: boolean
  notificationsSupported: boolean
  /**
   * macOS only: what SMAppService says about the item. `requires-approval`
   * counts as on (`openAtLogin` is true) but still needs a trip to System
   * Settings, which is the one thing the two launch surfaces say out loud.
   * Absent on every other platform, and on macOS builds that report nothing.
   */
  status?: 'not-registered' | 'enabled' | 'requires-approval' | 'not-found'
}

// ---------------------------------------------------------------------------
// Event pushes (main → renderer). One 'push' channel, discriminated payloads.

export type PushMessage =
  | { kind: 'boot'; boot: BootMode }
  | { kind: 'event'; conv: ConvId; event: VerifiedEvent }
  | { kind: 'channels'; channels: ChannelView[] }
  // Full replace, like 'channels' (1.2). Groups this device left or that were deleted are absent.
  | { kind: 'groups'; groups: GroupView[] }
  // Live boards (1.3): frames from other participants, delivered once each, in seq order per device.
  | { kind: 'board-frames'; sessionId: string; frames: BoardFrame[] }
  | { kind: 'board-ended'; sessionId: string }
  // Window fullscreen state (1.3), from enter/leave-full-screen.
  | { kind: 'fullscreen'; on: boolean }
  // Team settings (1.5): the folded team name changed (an admin renamed it).
  | { kind: 'team'; teamName: string }
  | { kind: 'presence'; views: PresenceView[] }
  // 1.4: this device's own row. `presence.views` is everyone *else* (main
  // filters the local device out of the roster), which is why the footer's
  // status was never visible — there was nothing to find. Pushed whenever the
  // local beacon presence changes; `presence.self()` is the same value pulled.
  | { kind: 'self-presence'; view: PresenceView }
  | { kind: 'typing'; conv: ConvId; deviceId: string; until: number }
  | { kind: 'cursors'; conv: ConvId; deviceId: string; cursor: CursorView }
  | { kind: 'health'; health: HealthView }
  | { kind: 'outbox'; queued: number } // messages and team writes waiting for remount
  | { kind: 'beam-offer'; offer: BeamOfferView }
  | { kind: 'beam-progress'; progress: BeamProgressView }
  | { kind: 'blob'; state: BlobFetchState }
  | { kind: 'screen-session'; session: ScreenSessionView }
  | { kind: 'update'; update: UpdateView }
  | { kind: 'skew-warning'; deviceId: string }
  | { kind: 'rtc-signal'; signal: RtcSignal }
  | { kind: 'frame'; sessionId: string; seq: number; bytes: Uint8Array }
  | { kind: 'frame-viewers'; sessionId: string; count: number }
  | { kind: 'prs'; prs: PrView[]; status: PrsStatus }
  // OS-notification click → renderer opens team:prs.
  | { kind: 'prs-open' }

// ---------------------------------------------------------------------------
// The bridge surface

export interface BridgeApi {
  platform: 'darwin' | 'win32' | 'linux'
  versions: { electron: string; chrome: string }

  /** Subscribe to all main→renderer pushes. Returns unsubscribe. */
  onPush(cb: (msg: PushMessage) => void): () => void

  app: {
    getBoot(): Promise<BootMode>
    unlock(passphrase: string): Promise<boolean>
    /** Forget this machine's sealed local data and start setup over (new device identity). */
    resetLocalData(): Promise<void>
    /** Disconnect from the current team folder and re-enter setup (name kept). */
    changeTeamFolder(): Promise<void>
    /** Quit and relaunch (macOS requires it after granting Screen Recording). */
    relaunch(): Promise<void>
    openExternal(url: string): Promise<void>
    copyText(text: string): Promise<void>
    showInFolder(path: string): Promise<void>
    setBadge(count: number): Promise<void>
    /** Reveal <share>/Chat/apps in Finder/Explorer (1.2 — peer-announced updates). */
    openAppsFolder(): Promise<void>
    /** 1.3: OS fullscreen for the main window (the diagram editor's whole-window mode). */
    setFullScreen(on: boolean): Promise<void>
    isFullScreen(): Promise<boolean>
    /** 1.4: login-item and notification facts for the launch nudge. */
    launchInfo(): Promise<LaunchInfo>
    /** 1.4: register/unregister Chat as a login item; resolves the resulting state. */
    setOpenAtLogin(on: boolean): Promise<{ openAtLogin: boolean }>
    /** 1.4: show a sample OS notification (triggers the macOS permission prompt on first use). */
    testNotification(): Promise<void>
  }

  onboarding: {
    pickFolder(): Promise<string | null>
    healthCheck(path: string): Promise<OnboardHealth>
    detectDevice(): Promise<{ hostname: string }>
    /**
     * `error` is either a sentence to show as-is or the machine-readable code
     * `'locked-profile'` — this machine already holds sealed local data that
     * nobody has unlocked, so setting up here would destroy the device
     * identity in it. `message` carries the sentence for any coded refusal
     * (additive and optional: older callers that only read `error` still
     * compile and still show something true).
     */
    submit(cfg: {
      sharePath: string
      passphrase: string
      displayName: string
      teamName: string
    }): Promise<{ ok: true } | { ok: false; error: string; message?: string }>
  }

  chat: {
    channels(): Promise<ChannelView[]>
    createChannel(name: string, topic?: string): Promise<ChannelView>
    dmFor(peerDeviceId: string): Promise<DmView | null>
    /** Full raw event list for a conversation (renderer materializes). */
    events(conv: ConvId): Promise<VerifiedEvent[]>
    send(conv: ConvId, draft: SendDraft): Promise<{ id: string }>
    edit(conv: ConvId, target: string, text: string): Promise<void>
    remove(conv: ConvId, target: string): Promise<void>
    react(conv: ConvId, target: string, emoji: string, op: 'add' | 'remove'): Promise<void>
    pin(conv: ConvId, target: string, op: 'pin' | 'unpin'): Promise<void>
    markRead(conv: ConvId, stem: string): Promise<void>
    setTyping(conv: ConvId | null): Promise<void>
    /** Remote cursors known so far: conv -> deviceId -> cursor. */
    cursors(conv: ConvId): Promise<Record<string, CursorView>>
    /** This device's own read watermarks, persisted across launches. */
    myReads(): Promise<Record<ConvId, string>>
    /** 1.2: publish a `channel-renamed` sys event (any member; rejects the fixed channel). */
    renameChannel(conv: ConvId, name: string): Promise<void>
    /** 1.2: publish a `channel-deleted` tombstone (any member; rejects the fixed channel). */
    deleteChannel(conv: ConvId): Promise<void>
    /** 1.3: vote on a poll message (`vot` event; [] retracts). Rejects unknown ids, multi violations, closed polls. */
    vote(conv: ConvId, target: string, choice: string[]): Promise<void>
    /** 1.3: author only — publish an `edt` of the poll with `closedAt`. */
    closePoll(conv: ConvId, target: string): Promise<void>
  }

  /**
   * Live boards (1.3): a real-time diagram session over boards/<sessionId>/.
   * Frames from others arrive as 'board-frames' pushes while joined.
   */
  boards: {
    /** Publish `board-live` and create the session dir. `boardId` ties it to a diagram message when seeded from one. */
    start(conv: ConvId, title: string, boardId?: string): Promise<{ sessionId: string }>
    /** Read every current frame, then keep polling and pushing until leave/end. */
    join(sessionId: string, conv: ConvId): Promise<{ frames: BoardFrame[] }>
    /**
     * Coalesced in main (BOARD.writeMinMs); the latest draft wins. Resolves
     * with the `files` ids the frame budget dropped (1.3), so the caller can
     * offer them again on a later frame rather than leaving a peer with a shape
     * whose image never arrives. A frame that is over budget on its elements
     * alone — or over `BOARD.maxElements` — rejects with `frame-too-large`.
     */
    write(sessionId: string, conv: ConvId, draft: BoardFrameDraft): Promise<{ droppedFiles: string[] }>
    /** Stop polling and delete this device's frame file. */
    leave(sessionId: string, conv: ConvId): Promise<void>
    /** Host only: publish `board-ended` and remove the dir. */
    end(sessionId: string, conv: ConvId, resultStem?: string): Promise<void>
  }

  /** Private groups (1.2). Reading is the ordinary event path (chat.events / 'event' pushes). */
  groups: {
    list(): Promise<GroupView[]>
    /** Create with `members` (deviceIds; self is added). Invites go out as DM sys events. */
    create(name: string, members: string[]): Promise<GroupView>
    rename(conv: ConvId, name: string): Promise<void>
    /** Owner only; the current epoch key is sealed to the newcomers (no rotation). */
    addMembers(conv: ConvId, members: string[]): Promise<void>
    /** Owner only: rotates to a new epoch key delivered to everyone but `member`. */
    removeMember(conv: ConvId, member: string): Promise<void>
    /** Publish `group-left` and forget the keys locally. */
    leave(conv: ConvId): Promise<void>
    /** Owner only: publish `group-deleted`; the janitor removes the dir after the grace period. */
    remove(conv: ConvId): Promise<void>
  }

  presence: {
    /** Everyone else on the team folder — never this device (see `self`). */
    list(): Promise<PresenceView[]>
    /** 1.4: this device's own row, for the footer. Null only before a session exists. */
    self(): Promise<PresenceView | null>
    setStatus(text: string): Promise<void>
    setAppearState(state: 'online' | 'offline'): Promise<void>
  }

  roster: {
    trust(deviceId: string, trust: Extract<TrustState, 'trusted' | 'flagged'>): Promise<void>
  }

  files: {
    /** Fetch (or begin fetching) a shared blob; push 'blob' reports progress. */
    fetchBlob(blobId: string, key: string, name: string, size: number): Promise<BlobFetchState>
    saveBlobAs(blobId: string, suggestedName: string): Promise<string | null>
    /** Drag-out support. */
    startDrag(blobId: string, name: string): Promise<void>
    /** Resolve a dropped DOM File to its absolute path (sync, via webUtils). */
    pathForFile(file: File): string
    /** 1.2: native open-file dialog; `bytes` is base64 (files ≤ 32 MB). */
    pickFile(opts: {
      title?: string
      filters: { name: string; extensions: string[] }[]
    }): Promise<{ path: string; name: string; bytes: string } | null>
    /** 1.2: native save dialog for renderer-produced bytes (base64). Resolves the path or null on cancel. */
    saveBytesAs(suggestedName: string, bytes: string, mime?: string): Promise<string | null>
    /** 1.2: write renderer-produced bytes (base64) to a staging file under userData, for AttachDraft.path. */
    stageBytes(name: string, bytes: string): Promise<{ path: string }>
  }

  beams: {
    send(peerDeviceId: string, filePaths: string[]): Promise<{ dropId: string }>
    accept(dropId: string, savePath?: string): Promise<void>
    decline(dropId: string): Promise<void>
    cancel(dropId: string): Promise<void>
  }

  links: {
    /** Sender-side metadata fetch; resolves quickly with failed:true when blocked. */
    preview(url: string): Promise<LinkPreview>
  }

  gifs: {
    packList(): Promise<{ id: string; category: string; url: string; w: number; h: number }[]>
    search(q: string): Promise<{ online: boolean; results: { url: string; w: number; h: number }[] }>
  }

  screen: {
    /** Empty list + systemPicker:true → call getDisplayMedia directly (macOS 15+). */
    sources(): Promise<{ sources: ScreenSourceView[]; systemPicker: boolean }>
    permission(): Promise<'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'>
    openPermissionSettings(): Promise<void>
    /** Arm the display-media handler with the chosen source before getDisplayMedia. */
    primeSource(sourceId: string): Promise<void>
    /** Publish the screenshare announce sys event; returns session + frame key material. */
    start(conv: ConvId, w: number, h: number): Promise<{ sessionId: string; frameKey: string; nonceBase: string }>
    stop(sessionId: string, conv: ConvId): Promise<void>
    /** Begin relay-viewing: main polls the session frame dir + heartbeats. */
    join(sessionId: string): Promise<void>
    leave(sessionId: string): Promise<void>
  }

  rtc: {
    /** Encrypt+sign+write one signal file (sealed to `signal.to`). */
    send(signal: RtcSignal): Promise<void>
    /** Switch the rtc/ poll cadence: fast during handshakes/presenting. */
    setPollMode(mode: 'fast' | 'idle'): Promise<void>
  }

  frames: {
    /** Presenter: write one encrypted frame to the ring (deletes seq-ringDepth). */
    publish(sessionId: string, seq: number, bytes: Uint8Array): Promise<void>
    /** Presenter: subscribe to viewer-heartbeat counts for the session. */
    watchViewers(sessionId: string, on: boolean): Promise<void>
  }

  /**
   * Team calendar. Reading is the ordinary event path —
   * chat.events(TEAM_CONV.calendar) + 'event' pushes → materializeCalendar.
   */
  calendar: {
    /**
     * Publish or overwrite an entry (LWW by id). Throws on validation failure.
     * An unreachable share is not a failure: the write goes to the outbox and
     * resolves with `{ queued: true }`, so the caller closes rather than
     * inviting a retry (a retried new entry would carry a second id).
     */
    put(entry: CalendarEntry): Promise<{ queued: boolean }>
    remove(id: string): Promise<{ queued: boolean }>
  }

  prs: {
    status(): Promise<PrsStatus>
    list(): Promise<PrView[]>
    refresh(): Promise<void>
    markSeen(keys: string[]): Promise<void>
    testConnection(input: { baseUrl: string; token: string }): Promise<PrsProbe>
    listRepos(input: {
      baseUrl: string
      token: string
      project: string
    }): Promise<AdoResult<{ id: string; name: string; defaultBranch: string }[]>>
    saveConfig(input: {
      baseUrl: string
      project: string
      repos: PrsRepo[]
      token: string
      shareToken: boolean
      /** 1.4 — team-shared thresholds; omitted = keep the current values (or the defaults). */
      reviewSlaHours?: number
      staleAfterDays?: number
    }): Promise<void>
    setPersonalToken(token: string | null): Promise<void>
    /** Publish an empty config and clear 'prs-seen'; keeps the personal token. */
    disconnect(): Promise<void>
  }

  settings: {
    get(): Promise<SettingsView>
    set(patch: Partial<SettingsView>): Promise<SettingsView>
  }

  update: {
    copyToMachine(): Promise<{ path: string } | { error: string }>
  }

  /** Team-wide settings (1.5). Reading is the ordinary event path (TEAM_CONV.settings) plus the 'team' push. */
  team: {
    /** Publish a `team-renamed` sys event (admins only — rejects `not-admin`; 1–40 chars). Queued when the share is unreachable. */
    rename(name: string): Promise<{ queued: boolean }>
  }

  /** Diagnostics (1.2). */
  diag: {
    shareStats(): Promise<ShareStats>
  }
}
