import { app, BrowserWindow, dialog } from 'electron'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { rmSync } from 'node:fs'
import type { BootMode, OnboardHealth, PushMessage, SelfView, SettingsView } from '@shared/bridge'
import { APP, DIR } from '@shared/constants'
import { restoredBeaconPresence, statusFromSettings } from '@shared/presenceStatus'
import { normalizeQuickMessages } from '@shared/quickMessages'
import { LocalStore } from './store/localStore'
import { platformKeystore } from './store/osKeystore'
import { ShareIo } from './transport/shareIo'
import { createOrJoinTeam, readProtocolFile } from './transport/bootstrap'
import { Roster } from './transport/roster'
import { Session } from './transport/session'
import { ChatService } from './services/chatService'
import { DRAG_TEMP_DIR } from './services/blobs'
import type { IoTierManager } from './services/ioTier'
import { Janitor } from './services/janitor'
import { UpdateService } from './services/updates'
import { PrService } from './services/prService'
import {
  currentHostname,
  gatherMachineIdHash,
  generateIdentity,
  identityFromStored,
  type DeviceIdentity,
  type StoredIdentity,
} from './crypto/identity'
import { deriveTeamKeys } from './crypto/keys'
import { sanitizeHostname } from '@shared/ids'

// Boot state machine + service owner. Everything IPC handlers touch lives here.

interface AppConfig {
  sharePath: string
  displayName: string
  teamName: string
}

interface CachedTeam {
  tmkB64: string
  tmk1B64: string
  epoch: number
}

/**
 * onboardSubmit's refusal code for "this profile is already someone's device,
 * and it is locked". Machine-readable on purpose: the renderer routes on it
 * (straight to the unlock screen) rather than pattern-matching a sentence, and
 * a script driving the bridge can tell this apart from a bad passphrase.
 */
export const LOCKED_PROFILE = 'locked-profile'

/** The sentence the renderer shows for {@link LOCKED_PROFILE}. */
export const LOCKED_PROFILE_MESSAGE =
  `This ${process.platform === 'darwin' ? 'Mac' : 'computer'} already holds Chat data. ` +
  'Unlock it with your passphrase first, or choose Reset local data to start over as a new device.'

const DEFAULT_SETTINGS: SettingsView = {
  theme: 'system',
  notifyChannels: 'mentions',
  notifyPreviews: true,
  autoplayGifs: 'always',
  autoAcceptBeams: false,
  quietHours: { enabled: false, from: '18:30', to: '09:00' },
  fontSize: 'M',
  // 1.4 — the launch nudge defaults to on; notifications default to
  // not-yet-accepted since app:testNotification is the only thing that flips it.
  suggestAtLaunch: true,
  notificationsAccepted: false,
  // 1.4 — the quick notification controls. Every default is what the app did
  // before they existed: all pull requests alert, DMs and private groups
  // notify, nothing is paused.
  notifyPrs: 'all',
  notifyDms: true,
  snoozeUntil: null,
  // null = the built-in quick-reply defaults (shared/quickMessages.ts);
  // set once someone edits the list in Settings → Quick messages.
  quickMessages: null,
  // 1.4 — the status line under your name. Empty until someone sets one; the
  // beacon is memory only, so this file is what carries it across a restart.
  status: '',
  // 1.5.x — reduced motion is a hard off for the eggs by default; this is the
  // explicit opt back in, offered only while reduced motion is actually on.
  easterEggsIgnoreReducedMotion: false,
}

export class AppController {
  readonly store = new LocalStore(app.getPath('userData'), platformKeystore())
  /**
   * Share I/O tier (1.2). Owned here so every service built in startSession can
   * follow it, but constructed and fed in src/main/index.ts — that is where the
   * powerMonitor and window signals live.
   */
  ioTier: IoTierManager | null = null
  chat: ChatService | null = null
  session: Session | null = null
  janitor: Janitor | null = null
  updates: UpdateService | null = null
  prs: PrService | null = null
  /**
   * Live-board service (1.3). Built lazily by `services/boardsIpc.ts` — it
   * needs the window to push to — but *stopped* here, with every other service
   * that owns timers: a board poller that outlives the session it was built for
   * keeps reading (and writing) a share the app has already left behind. The
   * type is structural on purpose, so this file takes no import for it.
   */
  boards: { stop(): Promise<void> } | null = null
  private readonly sessionListeners = new Set<() => void>()
  private identity: DeviceIdentity | null = null
  private settings: SettingsView = DEFAULT_SETTINGS
  private boot: BootMode = { mode: 'onboarding', sharePathSuggestion: null }
  private push: (msg: PushMessage) => void = () => {}

  constructor(private getWindow: () => BrowserWindow | null) {}

  setPush(push: (msg: PushMessage) => void): void {
    this.push = push
    this.chat?.setPush(push)
  }

  /** Wire the tier manager built in index.ts. Idempotent per manager. */
  setIoTierManager(manager: IoTierManager): void {
    this.ioTier = manager
    manager.onChange((tier, idleSec) => this.chat?.setIoTier(tier, idleSec))
  }

  /**
   * Session lifecycle hook: `chat` has just appeared, or has just gone away.
   *
   * The file/beam services — and with them the sfblob:// protocol handler that
   * every `<img>` in the timeline reads through — are built from
   * `controller.chat`, which is null until a session exists. They used to find
   * it on a 1 s poll, and that poll is a race the renderer wins: after a
   * relaunch it paints the cached timeline the moment the ready `boot` push
   * lands, its images ask sfblob:// before `initProtocol()` has run, and the
   * 503 they got back latched as "file service warming up" forever. Listeners
   * run synchronously here — before the boot push, and before the window
   * exists at launch — with the poll left in place as a backstop.
   */
  onSessionChange(listener: () => void): () => void {
    this.sessionListeners.add(listener)
    return () => {
      this.sessionListeners.delete(listener)
    }
  }

  private notifySessionChange(): void {
    for (const listener of [...this.sessionListeners]) {
      try {
        listener()
      } catch {
        // A service that fails to wire must not take the session down with it:
        // the poll behind this hook will try again a second later.
      }
    }
  }

  getBoot(): BootMode {
    return this.boot
  }

  getSettings(): SettingsView {
    return this.settings
  }

  setSettings(patch: Partial<SettingsView>): SettingsView {
    const next = { ...this.settings, ...patch }
    // Quick messages are the only setting that arrives as a list, so they are
    // the only one that can arrive over-long. Cap and clean them here as well
    // as in the editor, so what lands in settings.json can never exceed the
    // row's `maxEntries` — and a list that cleans away to nothing is stored as
    // null, the "use the defaults" value the renderer already understands.
    if (Array.isArray(next.quickMessages)) {
      const clean = normalizeQuickMessages(next.quickMessages)
      next.quickMessages = clean.length > 0 ? clean : null
    }
    this.settings = next
    this.store.writeSettings(this.settings)
    // Services read settings through the `() => this.settings` seam at the
    // point of decision, so nothing here has to be pushed — except a decision
    // already taken and now standing still: the beacon heartbeat, which a
    // paused device (locked screen) is not making any more. 1.5's
    // always-online lives exactly there.
    this.chat?.onSettingsChanged()
    return this.settings
  }

  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    const status = this.store.init()
    this.settings = { ...DEFAULT_SETTINGS, ...(this.store.readSettings<Partial<SettingsView>>() ?? {}) }

    switch (status) {
      case 'unlocked':
        await this.tryStartFromSavedConfig()
        return
      case 'passphrase':
        this.boot = { mode: 'locked', reason: 'passphrase' }
        return
      case 'unrecoverable':
        this.boot = { mode: 'locked', reason: 'unrecoverable' }
        return
      case 'fresh':
        // No LMK yet and no OS keystore: onboarding wraps one under the team
        // passphrase once it has it (onboardSubmit).
        this.boot = { mode: 'onboarding', sharePathSuggestion: null, savedName: null }
        return
    }
  }

  /**
   * The local data can't be opened — the seal doesn't fit (an OS keystore
   * entry from a build that still used the macOS Keychain, a profile copied
   * between user accounts) or the passphrase is gone. Forget it all and set
   * up again; the team folder itself is untouched.
   */
  async resetLocalData(): Promise<void> {
    // Only from the unlock screen: with a session running this would pull the
    // identity out from under it.
    if (this.boot.mode !== 'locked') return
    this.store.wipe() // takes the decrypted attachment cache with it
    this.clearDragTemp()
    this.store.init() // an OS keystore may create a fresh LMK right away; otherwise onboarding will
    this.boot = { mode: 'onboarding', sharePathSuggestion: null, savedName: null }
    this.push({ kind: 'boot', boot: this.boot })
  }

  private async tryStartFromSavedConfig(): Promise<void> {
    let config: AppConfig | null
    try {
      config = this.store.readSecretJson<AppConfig>('app-config')
    } catch {
      // The LMK opened but doesn't fit the secrets on disk (a seal replaced
      // over leftover *.enc): nothing here will ever decrypt.
      this.boot = { mode: 'locked', reason: 'unrecoverable' }
      return
    }
    if (!config) {
      this.boot = { mode: 'onboarding', sharePathSuggestion: null, savedName: null }
      return
    }
    try {
      await this.startSession(config)
    } catch (err) {
      // Share unreachable at launch → still enter the app in degraded mode?
      // v1: fall back to onboarding-with-error only if config is unusable;
      // for a missing mount, surface ready-with-degraded later. Keep simple:
      this.boot = { mode: 'onboarding', sharePathSuggestion: config.sharePath, savedName: config.displayName }
    }
  }

  /**
   * Disconnect from the current team folder and re-enter setup. The device
   * identity and display name are kept; team-scoped local state is cleared.
   * Old messages stay (encrypted) in the old folder — nothing is deleted.
   */
  async changeTeamFolder(): Promise<void> {
    const config = this.store.readSecretJson<AppConfig>('app-config')
    this.janitor?.stop()
    this.updates?.stop()
    this.prs?.stop()
    await this.boards?.stop().catch(() => {})
    await this.chat?.stop().catch(() => {})
    this.boards = null
    this.chat = null
    this.session = null
    this.janitor = null
    this.updates = null
    this.prs = null
    // Same hook, the other way round: the file/beam services stop now rather
    // than at the next poll, so nothing is left reading the folder we just left.
    this.notifySessionChange()
    // Team-scoped only. 'prs-seen' is about this team's pull requests and goes;
    // 'prs-token' is the user's own Azure DevOps credential and stays.
    for (const secret of [
      'app-config',
      'team-cache',
      'sender-seqs',
      'beacon-seq',
      'outbox',
      'read-cursors',
      'prs-seen',
      // Observed vote times for this team's pull requests (1.4).
      'prs-history',
      // Private-group keys and membership are this team's secrets (1.2).
      'groups',
    ]) {
      this.store.deleteSecret(secret)
    }
    // The decrypted attachment cache is this team's plaintext too: it must not
    // sit on disk after the folder it came from is gone.
    this.store.clearDerivedData()
    this.clearDragTemp()
    this.boot = {
      mode: 'onboarding',
      sharePathSuggestion: config?.sharePath ?? null,
      savedName: config?.displayName ?? null,
    }
    this.push({ kind: 'boot', boot: this.boot })
  }

  /** Plaintext copies BlobService leaves in temp so drags land under a real name. */
  private clearDragTemp(): void {
    try {
      rmSync(join(app.getPath('temp'), DRAG_TEMP_DIR), { recursive: true, force: true })
    } catch {
      // best effort: a file held open by a drag in flight is not worth failing on
    }
  }

  async unlock(passphrase: string): Promise<boolean> {
    const ok = this.store.unlockWithPassphrase(passphrase)
    if (ok) {
      await this.tryStartFromSavedConfig()
      this.push({ kind: 'boot', boot: this.boot })
    }
    return ok
  }

  // -------------------------------------------------------------------------
  // Onboarding

  async pickFolder(): Promise<string | null> {
    const win = this.getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the shared team folder',
      defaultPath: homedir(),
      properties: ['openDirectory', 'createDirectory'],
    })
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
  }

  async healthCheck(path: string): Promise<OnboardHealth> {
    const io = new ShareIo(await this.teamRoot(path))
    const health = await io.healthCheck()
    const proto = await readProtocolFile(io)
    return { ...health, existingTeamName: proto?.teamName ?? null }
  }

  private async teamRoot(sharePath: string): Promise<string> {
    // The app owns a subfolder inside whatever share the user picked, unless
    // they picked a folder that already IS a team root. Teams set up before
    // the rename live in `<share>/Semaphore/`; keep joining those rather than
    // splitting the team across two roots.
    const base = sharePath.replace(/[\\/]+$/, '')
    const leaf = basename(base)
    const hasTeam = (root: string): Promise<boolean> =>
      new ShareIo(root).statMaybe(DIR.protocolFile).then((s) => s !== null, () => false)
    if (leaf === APP.teamRootDirName) return base
    if (leaf === APP.legacyTeamRootDirName && (await hasTeam(base))) return base
    const root = `${base}/${APP.teamRootDirName}`
    const legacy = `${base}/${APP.legacyTeamRootDirName}`
    if (!(await hasTeam(root)) && (await hasTeam(legacy))) return legacy
    return root
  }

  async onboardSubmit(cfg: {
    sharePath: string
    passphrase: string
    displayName: string
    teamName: string
  }): Promise<{ ok: true } | { ok: false; error: string; message?: string }> {
    // Before anything touches the share: this machine may already hold a
    // device identity nobody has unlocked this launch. Setting up over it
    // would seal a *new* LMK over the old one and make identity.enc, pins.enc
    // and every cache permanently unreadable — the device would be gone and
    // its DMs with it. Refuse; only app.resetLocalData(), which the user
    // confirms on the unlock screen, may discard a sealed LMK.
    if (this.store.hasSealedData() && !this.store.unlocked) {
      return { ok: false, error: LOCKED_PROFILE, message: LOCKED_PROFILE_MESSAGE }
    }
    try {
      const root = await this.teamRoot(cfg.sharePath)
      const io = new ShareIo(root)
      await io.ensureDir('')
      const result = await createOrJoinTeam(io, cfg.passphrase, cfg.teamName || 'Team')
      if ('error' in result) {
        return { ok: false, error: result.error === 'wrong-passphrase' ? 'That passphrase does not match this team folder.' : 'This team folder needs a newer version of Chat.' }
      }
      const { proto, tmk } = result.join

      // Only now that the passphrase is known-good: on machines without an OS
      // keystore it is also what seals the local data, and it's the one the
      // unlock screen will ask for at the next launch — so a changed team
      // folder (or a rotated passphrase) must re-wrap the existing LMK.
      //
      // The locked-with-a-seal case never reaches here (refused at the top of
      // this method, and LocalStore throws under that anyway), so `!unlocked`
      // means one thing only: a genuinely fresh profile with nothing to lose.
      if (!this.store.unlocked) this.store.createPassphraseLmk(cfg.passphrase)
      else this.store.rewrapPassphrase(cfg.passphrase)
      const config: AppConfig = { sharePath: root, displayName: cfg.displayName, teamName: proto.teamName }
      this.store.writeSecretJson('app-config', config)
      this.store.writeSecretJson('team-cache', {
        tmkB64: tmk.toString('base64'),
        tmk1B64: tmk.toString('base64'),
        epoch: proto.epoch,
      })
      await this.startSession(config, io)
      this.push({ kind: 'boot', boot: this.boot })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not join the team folder.' }
    }
  }

  // -------------------------------------------------------------------------

  private async startSession(config: AppConfig, existingIo?: ShareIo): Promise<void> {
    const io = existingIo ?? new ShareIo(config.sharePath)
    const proto = await readProtocolFile(io)
    if (!proto) throw new Error('team folder unreachable or not initialized')

    const cached = this.store.readSecretJson<CachedTeam>('team-cache')
    if (!cached) throw new Error('no cached team key — passphrase required')
    const tmk = Buffer.from(cached.tmkB64, 'base64')
    const tmk1 = Buffer.from(cached.tmk1B64, 'base64')
    const teamSalt = Buffer.from(proto.kdf.saltB64, 'base64')

    // Identity: load or create once
    let storedId = this.store.readSecretJson<StoredIdentity>('identity')
    if (!storedId) {
      const gen = generateIdentity()
      storedId = gen.stored
      this.store.writeSecretJson('identity', storedId)
    }
    this.identity = identityFromStored(storedId)

    const keys = deriveTeamKeys(proto.epoch, tmk, tmk1, teamSalt)
    const roster = new Roster(io, this.store, keys.kMeta, proto.epoch)
    roster.loadPins()
    const session = new Session(io, this.store, this.identity, proto, teamSalt, tmk, tmk1, roster, config.displayName)

    // Publish/refresh our registration
    const machineIdHash = await gatherMachineIdHash()
    const prevSeq = this.store.readSecretJson<number>('rec-seq') ?? 0
    this.store.writeSecretJson('rec-seq', prevSeq + 1)
    await roster.publishSelf(this.identity, {
      deviceId: this.identity.deviceId,
      edPub: this.identity.edPub,
      xPub: this.identity.xPub,
      displayName: config.displayName,
      hostname: currentHostname(),
      osUser: process.env.USER ?? process.env.USERNAME ?? '',
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      machineIdHash,
      firstSeen: this.store.readSecretJson<number>('first-seen') ?? Date.now(),
      recSeq: prevSeq + 1,
    })
    if (!this.store.readSecretJson('first-seen')) this.store.writeSecretJson('first-seen', Date.now())

    this.session = session
    this.chat = new ChatService(session, this.getWindow, () => this.settings, () => app.getVersion())
    this.chat.setPush((msg) => this.push(msg))
    // 1.5 — the name protocol.json was created with. Anything a `team-renamed`
    // event folds on top of it (including on this cold start, from the log the
    // catch-up below ingests) wins; see services/teamSettings.ts.
    this.chat.teamNameBase = proto.teamName
    // The status survives the quit (1.4): put the saved one back before
    // `chat.start()` fires the first beacon, so teammates never see a blank
    // line while this device catches up — and neither does the footer.
    this.chat.beacon.presence = restoredBeaconPresence(this.chat.beacon.presence, statusFromSettings(this.settings))
    // Everything that hangs off a live ChatService gets built right here,
    // before the catch-up read and long before the ready `boot` push — see
    // onSessionChange. In particular the sfblob:// handler is live before the
    // renderer can ask it for its first image.
    this.notifySessionChange()
    await this.chat.start()
    // A session built after the manager already settled (unlock, team change)
    // would otherwise sit on the constructor default until the next transition.
    if (this.ioTier) this.chat.setIoTier(this.ioTier.tier, this.ioTier.idleSec)

    this.janitor = new Janitor(session)
    // Channels and groups tombstoned long enough ago that their directories can
    // go; ChatService holds the folded state that knows when that was (1.2).
    this.janitor.deletedConvs = () => this.chat?.deletedConvDirs() ?? []
    this.janitor.start()
    this.updates = new UpdateService(session, (msg) => this.push(msg))
    // A teammate's beacon advertising a newer build raises the update banner —
    // see UpdateService.notePeerVersion.
    this.chat.peerVersionHandler = (version, name) => this.updates?.notePeerVersion(version, name)
    this.updates.start()
    // After chat.start(): the PR service materializes its config from the
    // 'team:prs' log the startup catch-up has just filled in.
    this.prs = new PrService(
      this.chat,
      this.store,
      this.getWindow,
      (msg) => this.push(msg),
      () => app.getVersion(),
      () => this.settings,
    )
    this.prs.start()

    // 1.5 — a rename published by anyone (including this device) after the
    // catch-up: the renderer hears it as the `team` push ChatService sends,
    // and `getBoot()` has to agree, because that is what a window opened later
    // — or a relaunch that has not re-read the log yet — reads the name from.
    this.chat.teamNameHandler = (teamName) => {
      if (this.boot.mode !== 'ready') return
      this.boot = { mode: 'ready', self: { ...this.boot.self, teamName } }
    }
    // The cold-start fold is already in `chat.teamName()` — catchUp(team:settings)
    // ran inside chat.start(), before this line.
    this.boot = { mode: 'ready', self: this.selfView(config, this.chat.teamName()) }
  }

  private selfView(config: AppConfig, teamName: string): SelfView {
    const id = this.identity!
    return {
      deviceId: id.deviceId,
      displayName: config.displayName,
      hostname: sanitizeHostname(currentHostname()),
      fingerprint: id.fingerprint,
      teamName,
      sharePath: config.sharePath,
      platform: process.platform as 'darwin' | 'win32' | 'linux',
    }
  }

  async shutdown(): Promise<void> {
    this.janitor?.stop()
    this.updates?.stop()
    this.prs?.stop()
    await this.boards?.stop().catch(() => {})
    await this.chat?.stop().catch(() => {})
  }
}

export function detectDevice(): { hostname: string } {
  return { hostname: sanitizeHostname(currentHostname()) }
}

export { app }
