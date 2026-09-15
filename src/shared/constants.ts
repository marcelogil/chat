// Single reference table for every protocol constant. Values come from the
// reconciled FDC/1 spec; the share-conformance harness may override the timing
// numbers per deployment (they are read through TeamConfig at runtime).

import type { ConvId } from './types'

export const PROTOCOL = {
  name: 'fdc',
  version: 1,
  minReader: 1,
  minWriter: 1,
} as const

/** Share-relative directory layout (under the team root). */
export const DIR = {
  protocolFile: 'protocol.json',
  config: 'config',
  keys: 'keys',
  devices: 'devices',
  beacon: 'beacon',
  channels: 'channels',
  dm: 'dm',
  // App-defined team logs (calendar, pull-request config). Deliberately its own
  // top-level dir so the janitor's 180-day day-dir sweep (channels/, dm/ only)
  // never touches it — a birthday entered two years ago must survive.
  team: 'team',
  // Private groups (1.2): one opaque dir per group, `<token>/events/<day>/…`
  // like a channel but with no metadata file — the invite carries it.
  groups: 'groups',
  // Live boards (1.3): boards/<sessionId>/<deviceId8>.<seq> — transient, janitor-swept.
  boards: 'boards',
  blobs: 'blobs',
  blobsTmp: 'blobs/tmp',
  drops: 'drops',
  rtc: 'rtc',
  rtcTmp: 'rtc/.tmp',
  screens: 'screens',
  apps: 'apps',
  janitor: 'janitor',
  janitorClaims: 'janitor/claims',
} as const

/** The fixed set of team conversations. The whole ConvId is the key id. */
export const TEAM_CONV = {
  calendar: 'team:calendar',
  prs: 'team:prs',
  /** 1.5 — team-wide settings (today: the team name), LWW sys events. Admin-only to write; see TEAM_ADMIN_NAMES. */
  settings: 'team:settings',
} as const satisfies Record<string, ConvId>

/**
 * Display names allowed to change team-wide settings (1.5) — the admin rule,
 * written down once.
 *
 * There is no server to hold an admin list and no way to add one: the share is
 * a folder, and `protocol.json` is written once at team creation. So "admin" is
 * a name, compared trimmed and case-insensitively (`isGil`, `@shared/gilMode`),
 * and it is enforced in three places that all read this constant — the Settings
 * → Admin panel is listed only for these names, `ChatService.renameTeam`
 * refuses anyone else, and the fold in `services/teamSettings.ts` ignores a
 * `team-renamed` event whose author is not one of them. The fold is the one
 * that matters: it is what a hand-built event on the share runs into.
 *
 * Change the rule here and nowhere else.
 */
export const TEAM_ADMIN_NAMES = ['gil'] as const

/** Team calendar presentation constants. */
export const CALENDAR = {
  hues: 8, // colour = index into --hue-0..7
} as const

export const POLL = {
  /** Beacon readdir cadence (ms): focused / default / background window. */
  focusedMs: 1000,
  defaultMs: 1500,
  backgroundMs: 3000,
  /** 1.2 idle tier: no input for `idleAfterMs` (powerMonitor) → slow ticks; locked/suspended → paused. */
  idleMs: 15_000,
  idleAfterMs: 3 * 60_000,
  /** Blanket catch-up sweep (every conv's day dirs) per tier — heads carry the common case. */
  sweepFocusedMs: 60_000,
  sweepBlurredMs: 3 * 60_000,
  sweepIdleMs: 10 * 60_000,
  /** drops/<self> inbox scan; the beacon `drops` hint triggers an immediate one. */
  dropsInboxMs: 30_000,
  dropsInboxIdleMs: 5 * 60_000,
  /** rtc/ polling stops this long after the last signal or session. */
  rtcIdleOutMs: 2 * 60_000,
  /** rtc/ dir cadence while a handshake or live session involves this device. */
  rtcFastMs: 500,
  /** screens/<session> cadence for frame-relay viewers. */
  frameMs: 1000,
  /** Share remount probe while degraded. */
  remountMs: 5000,
  /** apps/version.json stat cadence. */
  updateMs: 5 * 60_000,
  /** Azure DevOps pull-request poll cadence. */
  prsMs: 60_000,
  /** Ceiling for the PR poller's exponential backoff after errors. */
  prsBackoffMaxMs: 10 * 60_000,
} as const

export const BEACON = {
  heartbeatMs: 20_000,
  heartbeatJitterMs: 3_000,
  /** Idle tier heartbeat — still < PRESENCE.offlineAfterMs, so 1.1 readers show "away", not "offline". */
  idleHeartbeatMs: 45_000,
  typingBumpMinMs: 3_000,
  typingTtlMs: 5_000,
  cursorCoalesceMs: 5_000,
  headsRingSize: 16,
} as const

export const PRESENCE = {
  onlineWithinMs: 50_000,
  offlineAfterMs: 120_000,
  awayIdleSec: 300,
  // Offline this long (by its own last beacon) and a device drops out of the
  // people list — its DM comes back the moment it does.
  departedAfterMs: 3 * 86_400_000,
} as const

export const HLC = {
  /** Max ms a device may ratchet past the calibrated share clock. */
  maxSkewAheadMs: 5 * 60_000,
} as const

export const EVENT = {
  /** Anything larger goes to the blob store. */
  maxFileBytes: 256 * 1024,
  /** Inline thumbnail budget inside a message event. */
  maxThumbBytes: 24 * 1024,
} as const

export const BLOB = {
  chunkBytes: 1024 * 1024, // SFB1 fixed chunk size
  uploadFailAfterMs: 10 * 60_000,
} as const

export const DROP = {
  autoAcceptDefault: false,
  stalledAfterMs: 2 * 60_000,
  failedAfterMs: 10 * 60_000,
} as const

export const RTC = {
  answerTimeoutMs: 6_000,
  iceConnectTimeoutMs: 5_000,
  disconnectGraceMs: 3_000,
  upgradeRetryAtMs: [30_000, 120_000] as readonly number[],
  meshMaxPeers: 4,
  wsConnectBudgetMs: 750,
  captureMaxWidth: 1920,
  captureMaxHeight: 1080,
  captureMaxFps: 15,
} as const

export const FRAME = {
  intervalMs: 1000,
  maxEdgePx: 1280,
  fallbackEdgePx: 1024,
  quality: 0.6,
  qualitySteps: [0.6, 0.45, 0.35] as readonly number[],
  budgetBytes: 300_000,
  ringDepth: 3,
  viewerHeartbeatMs: 10_000,
  viewerStaleMs: 30_000,
  pausedAfterMs: 5_000,
  endedAfterMs: 30_000,
} as const

export const XFER = {
  chunkBytes: 65_536,
  ackEveryBytes: 8 * 1024 * 1024,
  hiWaterBytes: 8 * 1024 * 1024,
  loWaterBytes: 1 * 1024 * 1024,
  stallMs: 15_000,
  channelOpenTimeoutMs: 3_000,
} as const

/** Default retention (days unless noted); team config can override. */
export const RETENTION = {
  eventDays: 180,
  blobDays: 7,
  dropHours: 72,
  rtcMinutes: 10,
  screensDeadMinutes: 2,
  screensHardHours: 24,
  tmpHours: 24,
  departedBeaconDays: 30,
  janitorClaimHours: 24,
  /** A deleted channel/group dir is removed by the janitor this long after its tombstone (1.2). */
  deletedConvGraceDays: 3,
  /** Live board dirs (1.3): swept when the newest frame is this old, and always after the hard limit. */
  boardsDeadMinutes: 10,
  boardsHardHours: 24,
} as const

export const JANITOR = {
  cadenceHours: 6,
  claimWaitMs: 30_000,
  jitterMaxMs: 15 * 60_000,
  compactAfterDays: 2, // day-dirs older than this get bundled
} as const

export const KDF = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  maxmem: 192 * 1024 * 1024,
  saltBytes: 32,
} as const

export const LINKPREVIEW = {
  fetchTimeoutMs: 3_000,
  maxRedirects: 2,
  maxImageBytes: 600 * 1024,
  cardImageW: 360,
  cardImageH: 180,
  maxEmbeddedImageBytes: 24 * 1024,
  domainFailureCacheMs: 60 * 60_000,
} as const

/** Domain-separation tags for Ed25519 signatures. */
export const DST = {
  record: 'smbchat-v1-rec', // generic signed wrapper (events, beacons, config)
  devrec: 'smbchat-v1-devrec',
  rtc: 'smbchat-v1-rtc',
  vouch: 'smbchat-v1-vouch',
  revoke: 'smbchat-v1-revoke',
  release: 'smbchat-v1-release', // apps/version.json
} as const

export const AAD_PREFIX = 'smbchat/v1'
export const HKDF_INFO = {
  file: 'smbchat/v1/file',
  stream: 'smbchat/v1/stream',
  seal: 'smbchat/v1/seal',
  check: 'smbchat/v1/check',
  meta: 'smbchat/v1/meta', // dir tokens — derived from epoch-1 TMK, stable across rotations
  dmRoot: 'smbchat/v1/dm-root',
  dmDirToken: 'dirtoken',
  grpDirToken: 'grp-dirtoken',
} as const

/** kid (key id) string builders — never contain secret material. */
export const KID = {
  meta: (epoch: number) => `e${epoch}/meta`,
  pres: (epoch: number) => `e${epoch}/pres`,
  conv: (epoch: number, convToken: string) => `e${epoch}/conv/${convToken}`,
  epochs: (epoch: number) => `e${epoch}/epochs`,
  dm: (pairToken: string) => `dm/${pairToken}`,
  /** Private group (1.2): the epoch is in the kid so a reader knows which key a record wants. */
  grp: (groupToken: string, epoch: number) => `grp/${groupToken}/e${epoch}`,
  /**
   * Live board frame (1.3), encrypted under the conversation key. The
   * conversation's own kid rides along, because for a private group that kid
   * names the *epoch*: a reader that just missed a rekey has to know which key
   * a frame wants before it can decide between "park this and retry" and
   * "refuse it" (boards.ts `keyForFrame`).
   */
  board: (sessionId: string, convKid: string) => `board/${sessionId}/${convKid}`,
  blob: (blobIdHex: string) => `blob/${blobIdHex}`,
  seal: (deviceId: string) => `seal/${deviceId.slice(0, 8)}`,
  local: (purpose: string) => `local/${purpose}`,
  frame: (sessionId: string) => `frm/${sessionId}`,
} as const

export const FILE_EXT = {
  record: '.e1',
  signal: '.sig',
  blob: '.blob',
  partial: '.partial',
} as const

/** Diagrams (1.2). */
/** Live boards (1.3): real-time diagram sessions over the folder. */
export const BOARD = {
  /** Writer coalescing: at most one frame per second, and only when something changed. */
  writeMinMs: 1000,
  /** Pointer-only frames are rarer still. */
  pointerMinMs: 2000,
  /** A frame even when nothing changed, so others keep you in the pointer list. */
  keepaliveMs: 10_000,
  /** Reader cadence while the live editor is open. */
  pollFocusedMs: 1000,
  pollBlurredMs: 3000,
  /** A participant silent this long drops out of the pointer list. */
  staleMs: 30_000,
  /** Frames above this are refused (files first, then the frame). */
  maxFrameBytes: 2 * 1024 * 1024,
  /**
   * Elements above this are refused outright (1.3): a scene this big is a
   * runaway, and the *sender* has to hear about it. Receivers clamp too, so
   * without this the cap was silent — the writer kept publishing frames that
   * every peer quietly truncated.
   */
  maxElements: 5000,
} as const

/** Polls (1.3). */
export const POLL_LIMITS = {
  minOptions: 2,
  maxOptions: 10,
  maxQuestionChars: 300,
  maxOptionChars: 100,
} as const

/** Pull-request waiting states (1.4). */
export const PRS = {
  reviewSlaHours: 48,
  staleAfterDays: 14,
  /** Threads + iterations of a tracked PR are re-read this often when nothing else triggers it. */
  detailRefreshMs: 5 * 60_000,
  /** Threads and iterations exist from this Azure DevOps REST version (TFS 2017). */
  minApiForThreads: '3.0',
  /** Bounds for the shared thresholds. */
  reviewSlaHoursRange: [1, 720] as readonly [number, number],
  staleAfterDaysRange: [1, 365] as readonly [number, number],
} as const

export const DIAGRAM = {
  /** Compressed scene bytes above this go to the blob store instead of inline. */
  maxInlineBytes: 120 * 1024,
  mime: 'application/vnd.excalidraw+json',
  ext: '.excalidraw',
} as const

/**
 * Share I/O budget per client (1.2), in logical share operations per minute
 * (one readdir, read, stat, or publish counts as one) with a team of ~5 and
 * nobody chatting. `poller.test.ts` asserts these; Settings shows the live rate.
 *
 * Idle and blurred were raised from 12/42 once the harness existed — the
 * originals sat exactly on the arithmetic floor of POLL.idleMs + four peers'
 * BEACON.idleHeartbeatMs + this device's own beacon, leaving nothing for the
 * blanket sweep, the drops inbox or the calibration stat. See
 * docs/contract-changes-1.2.md for the derivation and the measured numbers.
 */
export const IO_BUDGET = {
  idleOpsPerMin: 16,
  blurredOpsPerMin: 48,
  focusedOpsPerMin: 96,
} as const

export const APP = {
  id: 'com.semaphore.teamchat', // never changes: Windows AUMID + macOS TCC key on it
  teamRootDirName: 'Chat',
  legacyTeamRootDirName: 'Semaphore', // team folders created before the rename
  downloadsSubdir: 'Chat',
} as const
