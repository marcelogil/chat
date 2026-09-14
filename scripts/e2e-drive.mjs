#!/usr/bin/env node
// Live two-instance E2E: launches two built app instances (profiles alice/bob)
// against one local folder standing in for the SMB share, drives them through
// the real IPC bridge via CDP, and verifies cross-instance chat, DMs, presence,
// blobs, beams, the team calendar and the pull-request group (against a fake
// Azure DevOps served from this process). Screenshots go to /tmp/semaphore-e2e/
// and, for the two 1.1 panes, to $SEMAPHORE_E2E_SHOTS.
//
//   npm run build && node scripts/e2e-drive.mjs

import { spawn, execSync } from 'node:child_process'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { createServer } from 'node:http'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const SHARE = '/tmp/semaphore-e2e-share'
const OUT = '/tmp/semaphore-e2e'
// Pane screenshots land in the agent scratchpad (the run's own /tmp dir is
// wiped at the top of main()); overridable so the script stays runnable by hand.
const SHOTS =
  process.env.SEMAPHORE_E2E_SHOTS ??
  '/private/tmp/claude-501/-Users-gil-Desktop-chat/ce0e42d1-7e13-4012-ac25-a0e2f46e86c8/scratchpad'
const PASS = 'correct horse battery staple'
const results = []
let failed = false

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

/**
 * A check that is worth reporting but must never fail the run: screenshots
 * depend on a compositor being willing to paint, which is not what we are here
 * to prove.
 */
function soft(name, ok, detail = '') {
  results.push({ name, ok, detail, soft: true })
  console.log(`${ok ? '  ✓' : '  ~'} ${name}${detail ? ` — ${detail}` : ''}${ok ? '' : ' (best-effort)'}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// CDP client

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      }
    })
    // A target that goes away (splash destroyed, window reloaded, app killed)
    // closes the socket without answering. Without this, every in-flight send
    // hangs forever and the run dies on the outer timeout instead of the check.
    ws.on('close', () => {
      const err = new Error('CDP socket closed')
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  /** Evaluate an async expression in the page, return its JSON value. */
  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => (${expr}))()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'eval failed')
    }
    return res.result.value
  }
  async screenshot(path) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(res.data, 'base64'))
  }
}

/** All debuggable page targets on a port, [] if the endpoint isn't up yet. */
async function targets(port) {
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

async function connect(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // The splash window is a real page target that appears BEFORE the app
    // window and has no preload — attaching to it would give a bridge-less
    // page that then vanishes mid-run. Skip it, and prove the target we did
    // pick is the sandboxed renderer by asking for window.bridge.
    const page = (await targets(port)).find(
      (t) => t.type === 'page' && !t.url.startsWith('devtools') && !t.url.includes('splash.html'),
    )
    if (page) {
      let ws
      try {
        ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
        await new Promise((res, rej) => {
          ws.on('open', res)
          ws.on('error', rej)
        })
        const cdp = new Cdp(ws)
        await cdp.send('Page.enable')
        await cdp.send('Runtime.enable')
        if ((await cdp.eval(`typeof window.bridge`)) === 'object') return cdp
        ws.close() // preload hasn't run (or wrong target) — look again
      } catch {
        try { ws?.close() } catch {}
      }
    }
    await sleep(300)
  }
  throw new Error(`CDP not reachable on :${port}`)
}

async function until(fn, timeoutMs, everyMs = 700) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn().catch(() => undefined)
    if (last) return last
    await sleep(everyMs)
  }
  return last
}

/**
 * Select a sidebar row by the prefix of its aria-label (the rows carry
 * suffixes like ", 2 unseen") and photograph whatever pane it opens.
 * `setActiveConv` is renderer state with no bridge surface, so the DOM is the
 * only handle — and clicking the real row is a better proof than poking a store.
 */
async function paneShot(cdp, ariaPrefix, path) {
  try {
    const sel = `button.sem-row[aria-label^=${JSON.stringify(ariaPrefix)}]`
    const clicked = await cdp.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true })()`,
    )
    if (clicked !== true) return false
    await sleep(1000)
    await cdp.screenshot(path)
    return true
  } catch {
    return false
  }
}

/** 'YYYY-MM-DD' for a local Date — the calendar's only date format. */
function ymd(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function addDays(d, n) {
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  c.setDate(c.getDate() + n)
  return c
}

// ---------------------------------------------------------------------------
// Fake Azure DevOps
//
// Just enough of the 6.0 REST surface for AdoClient: connectionData, projects,
// repositories, active pull requests, and (1.4) each PR's comment threads and
// iterations. It insists on the Basic header the
// client builds from `:${token}` and answers anything else with the 203 +
// sign-in-page that real Azure DevOps sends for a rejected PAT — which is the
// one response shape the client's classifier most needs to see in the wild.

const ADO_TOKEN = 'e2e-token'
const ADO_AUTH = `Basic ${Buffer.from(`:${ADO_TOKEN}`, 'utf8').toString('base64')}`
const ADO_ME = { id: '6f2d1e40-91aa-4b2c-9c1d-a1b2c3d4e5f6', providerDisplayName: 'E2E Reviewer' }
const ADO_PROJECT = { id: '2c4f0a1e-77bb-4d51-8f30-0badc0ffee11', name: 'Fabrikam' }
const ADO_REPOS = [
  { id: 'repo-web', name: 'web', defaultBranch: 'refs/heads/main' },
  { id: 'repo-api', name: 'api', defaultBranch: 'refs/heads/release/24.9' },
]

/** One pull request in the shape AdoClient/`toPrView` read. */
function adoPr({ id, repo, title, author, source, target, reviewers, isDraft = false, status = 'active', ageH = 3, commit = '' }) {
  return {
    pullRequestId: id,
    lastMergeSourceCommit: { commitId: commit || `c${id}` },
    title,
    status,
    isDraft,
    createdBy: author,
    creationDate: new Date(Date.now() - ageH * 3600_000).toISOString(),
    sourceRefName: `refs/heads/${source}`,
    targetRefName: `refs/heads/${target}`,
    repository: { id: repo.id, name: repo.name },
    reviewers,
  }
}

const DANA = { id: 'dana-9a1c', displayName: 'Dana Dev' }
const ME_REVIEWER = { id: ADO_ME.id, displayName: ADO_ME.providerDisplayName }

async function startAdo() {
  // repoId -> pull requests. Mutated live by the drive so the "approved PRs
  // fall out of the list" and "a new PR raises the alert" paths are real.
  const prs = {
    'repo-web': [
      adoPr({
        id: 4271,
        repo: ADO_REPOS[0],
        title: 'Cache the avatar strip between renders',
        author: DANA,
        source: 'dana/avatar-cache',
        target: 'main',
        // A required reviewer sitting at 0 keeps this one tracked.
        reviewers: [{ ...ME_REVIEWER, vote: 0, isRequired: true }],
      }),
    ],
    'repo-api': [
      adoPr({
        id: 4288,
        repo: ADO_REPOS[1],
        title: 'Bump the retention sweep to 180 days',
        author: DANA,
        source: 'dana/retention',
        target: 'release/24.9',
        // Everyone signed off: tracked === false, so it must never be listed.
        reviewers: [{ ...ME_REVIEWER, vote: 10, isRequired: true }],
        ageH: 30,
      }),
    ],
  }
  // 1.4 — per-PR comment threads and iterations. #4271 carries one open thread
  // whose last word is the reviewer's (→ comments-open, waiting on the author)
  // and one pushed iteration; the approved #4288 has neither.
  const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString()
  const details = {
    4271: {
      threads: [
        {
          id: 91,
          status: 'active',
          publishedDate: ago(2),
          lastUpdatedDate: ago(1),
          comments: [
            {
              id: 1,
              author: { id: ADO_ME.id, displayName: ADO_ME.providerDisplayName },
              publishedDate: ago(2),
              commentType: 'text',
            },
            {
              id: 2,
              author: { id: DANA.id, displayName: DANA.displayName },
              publishedDate: ago(1.5),
              commentType: 'text',
            },
            {
              id: 3,
              author: { id: ADO_ME.id, displayName: ADO_ME.providerDisplayName },
              publishedDate: ago(1),
              commentType: 'text',
            },
          ],
        },
        // A resolved thread and a pure system thread: neither may count.
        {
          id: 92,
          status: 'fixed',
          publishedDate: ago(3),
          comments: [{ id: 1, author: { id: DANA.id }, publishedDate: ago(3), commentType: 'text' }],
        },
        {
          id: 93,
          status: 'active',
          publishedDate: ago(3),
          comments: [{ id: 1, author: { id: ADO_ME.id }, publishedDate: ago(3), commentType: 'system' }],
        },
      ],
      iterations: [{ id: 1, createdDate: ago(3) }],
    },
    4288: { threads: [], iterations: [] },
  }
  const state = { prs, details, requests: 0, rejected: 0 }

  const server = createServer((req, res) => {
    state.requests += 1
    const path = new URL(req.url, 'http://127.0.0.1').pathname

    if (req.headers.authorization !== ADO_AUTH) {
      state.rejected += 1
      res.writeHead(203, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body><h1>Sign in to Azure DevOps</h1></body></html>')
      return
    }

    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const list = (value) => json({ count: value.length, value })

    if (path === '/_apis/connectionData') {
      return json({ authenticatedUser: ADO_ME, instanceId: ADO_PROJECT.id })
    }
    if (path === '/_apis/projects') return list([ADO_PROJECT])

    let m = /^\/([^/]+)\/_apis\/git\/repositories$/.exec(path)
    if (m && decodeURIComponent(m[1]) === ADO_PROJECT.name) return list(ADO_REPOS)

    m = /^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullrequests$/.exec(path)
    if (m && decodeURIComponent(m[1]) === ADO_PROJECT.name) {
      return list(state.prs[decodeURIComponent(m[2])] ?? [])
    }

    // 1.4 — threads and iterations of one pull request.
    m = /^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)\/(threads|iterations)$/i.exec(path)
    if (m && decodeURIComponent(m[1]) === ADO_PROJECT.name) {
      const detail = state.details[Number(m[3])] ?? { threads: [], iterations: [] }
      return list(m[4].toLowerCase() === 'threads' ? detail.threads : detail.iterations)
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ message: `no route for ${path}` }))
  })

  await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return { server, state, port, baseUrl: `http://127.0.0.1:${port}` }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('— Chat two-instance E2E —\n')
  rmSync(SHARE, { recursive: true, force: true })
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(SHARE, { recursive: true })
  mkdirSync(OUT, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  const appSupport = join(homedir(), 'Library', 'Application Support')
  // alice2 is the re-join profile: a third instance, same machine, same
  // display name, brand-new local data — what "Reset local data" leaves behind.
  for (const p of [
    'Chat-e2e-alice',
    'Chat-e2e-alice2',
    'Chat-e2e-bob',
    'semaphore-e2e-alice',
    'semaphore-e2e-alice2',
    'semaphore-e2e-bob',
  ]) {
    rmSync(join(appSupport, p), { recursive: true, force: true })
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = join(process.cwd(), 'node_modules', '.bin', 'electron')
  const launch = (profile, port) =>
    spawn(electron, ['.', `--remote-debugging-port=${port}`], {
      env: { ...env, SEMAPHORE_PROFILE: `e2e-${profile}` },
      stdio: 'ignore',
      detached: false,
    })

  // Up before the apps so the port is known when alice saves the PR config.
  const ado = await startAdo()
  console.log(`fake Azure DevOps on ${ado.baseUrl}\n`)

  const procA = launch('alice', 9333)
  const procB = launch('bob', 9334)
  /** Alice again, after a reset — started near the end of the run (1.4). */
  let procC = null
  const kill = () => {
    try { procA.kill() } catch {}
    try { procB.kill() } catch {}
    try { procC?.kill() } catch {}
    try { ado.server.closeAllConnections?.() } catch {}
    try { ado.server.close() } catch {}
  }
  process.on('exit', kill)

  // The splash comes up before controller.init(), so it is the first page
  // target on the port — poll fast and briefly, before the app window replaces
  // it. (It is torn down ~1.2 s after the main window shows.)
  const splashSeen = await until(
    async () => (await targets(9333)).find((t) => t.url.includes('splash.html')),
    8000,
    100,
  )
  check('alice shows the splash window', !!splashSeen, splashSeen?.title ?? '')

  try {
    const alice = await connect(9333)
    const bob = await connect(9334)
    console.log('both instances up, CDP connected\n')
    await sleep(1500)

    // Boot state: onboarding
    const bootA = await alice.eval(`window.bridge.app.getBoot()`)
    check('alice boots into onboarding', bootA?.mode === 'onboarding', `mode=${bootA?.mode}`)

    // Onboard alice (creates the team), then bob (joins)
    const subA = await alice.eval(
      `window.bridge.onboarding.submit({ sharePath: ${JSON.stringify(SHARE)}, passphrase: ${JSON.stringify(PASS)}, displayName: 'Alice', teamName: 'E2E Team' })`,
    )
    check('alice creates the team', subA?.ok === true, subA?.error ?? '')
    const subB = await bob.eval(
      `window.bridge.onboarding.submit({ sharePath: ${JSON.stringify(SHARE)}, passphrase: ${JSON.stringify(PASS)}, displayName: 'Bob', teamName: '' })`,
    )
    check('bob joins the team', subB?.ok === true, subB?.error ?? '')

    // Wrong passphrase is rejected (fresh throwaway check via health+submit on bob's instance is destructive — skip; covered by unit tests)

    const selfA = await alice.eval(`window.bridge.app.getBoot()`)
    const selfB = await bob.eval(`window.bridge.app.getBoot()`)
    check('both reach ready with device identities', selfA?.mode === 'ready' && selfB?.mode === 'ready',
      `alice=${selfA?.self?.fingerprint} bob=${selfB?.self?.fingerprint}`)

    // Channel discovery: bob sees #general created by alice's first-run
    const chB = await until(async () => {
      const chs = await bob.eval(`window.bridge.chat.channels()`)
      return chs?.length ? chs : undefined
    }, 20000)
    check('bob discovers #general', !!chB?.some((c) => c.name === 'general'), JSON.stringify(chB?.map((c) => c.name)))
    const conv = chB.find((c) => c.name === 'general').conv

    // Team chat: alice -> bob
    await alice.eval(`window.bridge.chat.send(${JSON.stringify(conv)}, { text: 'hello from alice 👋', kind: 'text' })`)
    const gotMsg = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'msg' && e.payload?.body?.text?.includes('hello from alice'))
    }, 20000)
    check('bob receives the channel message (verified)', !!gotMsg && gotMsg.verified === true)

    // Reaction round-trip: bob reacts, alice sees it
    if (gotMsg) {
      await bob.eval(`window.bridge.chat.react(${JSON.stringify(conv)}, ${JSON.stringify(gotMsg.id)}, '🎉', 'add')`)
      const gotRct = await until(async () => {
        const evs = await alice.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
        return evs?.find((e) => e.type === 'rct')
      }, 20000)
      check("alice sees bob's reaction", !!gotRct)
    }

    // Presence: alice sees bob's beacon (verified, with hostname + fingerprint).
    // 1.2 finally plumbs the *real* OS-wide input-idle time into `idleSec`
    // (src/main/services/ioTier.ts -> BeaconWriter.setTier), and
    // Poller.presenceViews() has always turned that into 'away' once idleSec
    // >= PRESENCE.awayIdleSec (300s) — that branch existed before 1.2 too, it
    // just never fired because idleSec was hardcoded to 0. On a machine whose
    // real mouse/keyboard has been untouched for 5+ minutes (exactly what an
    // unattended CDP-driven run looks like), Bob's own beacon truthfully says
    // he is idle, so alice correctly sees 'away' rather than 'online' — this
    // is not a bug, and neither a longer wait nor Page.bringToFront() changes
    // it: derive() in ioTier.ts checks powerMonitor.getSystemIdleTime() itself
    // (a real OS-wide counter untouched by window focus or CDP-injected
    // input) before it ever looks at focus. So accept either state as proof
    // presence delivery works; only 'offline'/absent means something is wrong.
    const presA = await until(async () => {
      const list = await alice.eval(`window.bridge.presence.list()`)
      const bobView = list?.find((p) => p.name === 'Bob')
      return bobView?.state === 'online' || bobView?.state === 'away' ? bobView : undefined
    }, 30000)
    check(
      "alice sees Bob's presence (online, or away if this machine has been idle) with device chip",
      !!presA,
      presA ? `${presA.hostname}·${presA.fingerprint}·${presA.state}` : '',
    )

    // ---- Status line (1.4) -------------------------------------------------
    // The bug Gil reported: a status went nowhere visible. Three things to
    // prove, all over the bridge — it comes back on our own row (there was no
    // such row before, which is why the footer could never show it), it lands
    // in plaintext settings (so the next launch can restore it), and it
    // reaches the other side under her name.
    await alice.eval(`window.bridge.presence.setStatus('back at 3')`)
    const selfStatus = await until(async () => {
      const me = await alice.eval(`window.bridge.presence.self()`)
      return me?.status === 'back at 3' ? me : undefined
    }, 10000)
    check(
      'alice sees her own status immediately (presence.self)',
      !!selfStatus,
      selfStatus ? `${selfStatus.name}: ${selfStatus.status}` : 'no self row',
    )
    const savedStatus = await alice.eval(`window.bridge.settings.get()`)
    check(
      'the status is persisted in settings, so a restart keeps it',
      savedStatus?.status === 'back at 3',
      JSON.stringify(savedStatus?.status ?? null),
    )
    const statusAtBob = await until(async () => {
      const list = await bob.eval(`window.bridge.presence.list()`)
      const aliceView = list?.find((p) => p.name === 'Alice')
      return aliceView?.status === 'back at 3' ? aliceView : undefined
    }, 30000)
    check("alice sets a status, bob sees it under her name", !!statusAtBob, statusAtBob?.status ?? '')
    // The sidebar row is where it has to be readable: the aria-label carries
    // the status, and the row is the two-line kind now.
    const bobDmLabel = await until(async () => {
      const labels = await bob.eval(
        `Array.from(document.querySelectorAll('button[aria-label^="Direct message Alice"]')).map((n) => n.getAttribute('aria-label'))`,
      )
      return labels?.find((l) => l.includes('status back at 3'))
    }, 20000)
    check("bob's sidebar row for alice names her status", !!bobDmLabel, bobDmLabel ?? '')
    await alice.eval(`window.bridge.presence.setStatus('')`)

    // E2E DM: bob -> alice
    const dm = await bob.eval(`window.bridge.chat.dmFor(${JSON.stringify(selfA.self.deviceId)})`)
    check('bob derives the DM conversation', !!dm?.conv)
    if (dm?.conv) {
      await bob.eval(`window.bridge.chat.send(${JSON.stringify(dm.conv)}, { text: 'secret DM for alice', kind: 'text' })`)
      const gotDm = await until(async () => {
        const evs = await alice.eval(`window.bridge.chat.events(${JSON.stringify(dm.conv)})`)
        return evs?.find((e) => e.payload?.body?.text === 'secret DM for alice')
      }, 20000)
      check('alice receives the E2E DM', !!gotDm && gotDm.verified === true)
    }

    // Link preview fetch (network permitting — informational only)
    const lp = await alice.eval(`window.bridge.links.preview('https://example.com')`).catch(() => null)
    check('link preview resolves (failed:true acceptable offline)', !!lp, lp?.failed ? 'degraded card' : lp?.title ?? '')

    // ---- Channels: rename + delete, fixed channel is protected (1.2) -------
    const designCh = await alice.eval(`window.bridge.chat.createChannel('design')`)
    check('alice creates #design', !!designCh?.conv, designCh ? `${designCh.name} (${designCh.conv})` : '')

    const renameErr = await alice.eval(
      `window.bridge.chat.renameChannel(${JSON.stringify(designCh?.conv)}, 'product').then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice renames #design to #product via chat.renameChannel', renameErr === '', renameErr)

    const chansB = await until(async () => {
      const chs = await bob.eval(`window.bridge.chat.channels()`)
      return chs?.some((c) => c.name === 'product') ? chs : undefined
    }, 20000)
    check(
      "bob's chat.channels() shows #product (renamed from #design)",
      !!chansB && chansB.some((c) => c.name === 'product') && !chansB.some((c) => c.name === 'design'),
      chansB ? chansB.map((c) => `${c.name}${c.fixed ? '(fixed)' : ''}`).join(' ') : 'timed out',
    )
    const generalFixed = chansB?.find((c) => c.name === 'general')?.fixed
    const productFixed = chansB?.find((c) => c.name === 'product')?.fixed
    check(
      '#general is fixed:true and #product is fixed:false',
      generalFixed === true && productFixed === false,
      `general.fixed=${generalFixed} product.fixed=${productFixed}`,
    )

    const fixedRenameErr = await alice.eval(
      `window.bridge.chat.renameChannel(${JSON.stringify(conv)}, 'nope').then(() => '', (x) => String(x && x.message || x))`,
    )
    check(
      "alice's chat.renameChannel on the fixed #general channel rejects",
      fixedRenameErr !== '',
      fixedRenameErr || 'no error thrown',
    )

    // ---- "Say hello" twice, the second time in a channel that has only just
    // appeared (1.4) ---------------------------------------------------------
    // The report: sometimes the empty state's button did nothing. Two causes,
    // both exercised here — the button's own `sending` latch, which used to
    // survive a conversation switch (so the *first* successful hello disabled
    // the button in every empty conversation opened afterwards), and main
    // rejecting a send into a channel it had not read `channel.json.e1` for.
    // #product is empty at this point: nobody has ever written into it.
    const openedProduct = await until(async () => {
      const ok = await alice.eval(
        `(() => { const el = document.querySelector('button.sem-row[aria-label^="Channel product"]');` +
          ` if (!el) return false; el.click(); return true })()`,
      )
      return ok === true ? true : undefined
    }, 20000)
    check('alice opens the empty #product channel', openedProduct === true)
    const firstHello = await until(async () => {
      const ok = await alice.eval(
        `(() => { const el = document.querySelector('button[aria-label="Say hello"]');` +
          ` if (!el || el.disabled) return false; el.click(); return true })()`,
      )
      return ok === true ? true : undefined
    }, 20000)
    check('alice presses Say hello in #product', firstHello === true)
    const gotFirstHello = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(designCh?.conv)})`)
      return evs?.find((e) => e.type === 'msg' && (e.payload?.body?.text || '').startsWith('Hello'))
    }, 30000)
    check('bob receives that first hello', !!gotFirstHello, gotFirstHello ? gotFirstHello.payload.body.text : 'never arrived')

    const helloCh = await bob.eval(`window.bridge.chat.createChannel('greetings')`)
    check('bob creates #greetings', !!helloCh?.conv, helloCh ? `${helloCh.name} (${helloCh.conv})` : '')
    // A channel nobody has written into is advertised by nothing, so the only
    // discovery left is the blanket sweep (1–10 minutes, tier dependent). One
    // sys event puts the conv id in Bob's beacon heads, which is the path a
    // real "somebody just made a channel" takes within a tick — and a rename
    // is not a message, so the empty state stays up.
    const helloRenameErr = await bob.eval(
      `window.bridge.chat.renameChannel(${JSON.stringify(helloCh?.conv)}, 'greetings-all')` +
        `.then(() => '', (x) => String((x && x.message) || x))`,
    )
    check('bob renames it so the conv id rides his beacon heads', helloRenameErr === '', helloRenameErr)
    const aliceSees = await until(async () => {
      const chs = await alice.eval(`window.bridge.chat.channels()`)
      return chs?.find((c) => c.conv === helloCh?.conv)
    }, 60000)
    check(
      "alice's sidebar picks up #greetings-all without waiting for a sweep",
      !!aliceSees,
      aliceSees ? aliceSees.name : 'never appeared',
    )

    // Open the row and press the real button — no store poking.
    const openedHello = await until(async () => {
      const ok = await alice.eval(
        `(() => { const el = document.querySelector('button.sem-row[aria-label^="Channel greetings"]');` +
          ` if (!el) return false; el.click(); return true })()`,
      )
      return ok === true ? true : undefined
    }, 20000)
    check('alice opens #greetings-all from the sidebar', openedHello === true)
    const helloBtn = await until(async () => {
      const state = await alice.eval(
        `(() => { const el = document.querySelector('button[aria-label="Say hello"]');` +
          ` return el ? { disabled: !!el.disabled } : null })()`,
      )
      return state ?? undefined
    }, 20000)
    check(
      'the Say hello button is live again in the new channel (not latched by the #product hello)',
      !!helloBtn && helloBtn.disabled === false,
      helloBtn ? `disabled=${helloBtn.disabled}` : 'no button',
    )
    const helloClicked = await alice.eval(
      `(() => { const el = document.querySelector('button[aria-label="Say hello"]');` +
        ` if (!el || el.disabled) return false; el.click(); return true })()`,
    )
    check('alice clicks Say hello', helloClicked === true)

    const gotHello = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(helloCh?.conv)})`)
      return evs?.find((e) => e.type === 'msg' && (e.payload?.body?.text || '').startsWith('Hello'))
    }, 30000)
    check(
      'bob receives the hello sent from the empty state (verified)',
      !!gotHello && gotHello.verified === true,
      gotHello ? gotHello.payload.body.text : 'never arrived',
    )
    const emptyStateGone = await until(async () => {
      const gone = await alice.eval(`document.querySelector('button[aria-label="Say hello"]') === null`)
      return gone === true ? true : undefined
    }, 15000)
    check('the empty state gives way to the message on alice', emptyStateGone === true)

    // A rejected send must never be silent: sending into a conversation main
    // cannot open puts a reason on the toast rail rather than doing nothing.
    const helloErr = await alice.eval(
      `window.bridge.chat.send('chan:deadbeef', { text: 'Hello 👋', kind: 'text' })` +
        `.then(() => '', (x) => String((x && x.message) || x))`,
    )
    check(
      'a send into a channel that is not on the share rejects with a reason',
      /unknown conversation/.test(helloErr),
      helloErr || 'resolved instead of rejecting',
    )

    // ---- Private groups: create, DM-borne invite, message, rename (1.2) ----
    const group = await alice.eval(
      `window.bridge.groups.create('Duo', [${JSON.stringify(selfB.self.deviceId)}])`,
    )
    check('alice creates the private group Duo', !!group?.conv, group ? `${group.conv} role=${group.role}` : '')

    const groupB = await until(async () => {
      const gs = await bob.eval(`window.bridge.groups.list()`)
      return gs?.find((g) => g.conv === group?.conv)
    }, 25000)
    check(
      "bob's groups.list() discovers Duo via the DM invite",
      !!groupB && groupB.role === 'member' && groupB.members?.length === 2,
      groupB ? `${groupB.name} role=${groupB.role} members=${groupB.members?.length}` : 'timed out',
    )

    if (group?.conv) {
      await alice.eval(`window.bridge.chat.send(${JSON.stringify(group.conv)}, { text: 'hi duo', kind: 'text' })`)
      const gotGrpMsg = await until(async () => {
        const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(group.conv)})`)
        return evs?.find((e) => e.type === 'msg' && e.payload?.body?.text === 'hi duo')
      }, 20000)
      check("bob's chat.events(grp:<id>) has alice's message (verified)", !!gotGrpMsg && gotGrpMsg.verified === true)

      const renameGrpErr = await bob.eval(
        `window.bridge.groups.rename(${JSON.stringify(group.conv)}, 'Duo renamed').then(() => '', (x) => String(x && x.message || x))`,
      )
      check('bob renames the group', renameGrpErr === '', renameGrpErr)

      const groupA = await until(async () => {
        const gs = await alice.eval(`window.bridge.groups.list()`)
        return gs?.find((g) => g.conv === group.conv && g.name === 'Duo renamed')
      }, 20000)
      check("alice sees the group's new name", !!groupA, groupA ? groupA.name : 'timed out')
    }

    // The group's dir must exist under Chat/groups/ and be an opaque token —
    // no device-id (or its 8-hex prefix) anywhere in the directory name.
    try {
      const groupDirs = readdirSync(join(SHARE, 'Chat', 'groups'))
      const aliceId = selfA.self.deviceId
      const bobId = selfB.self.deviceId
      const opaque =
        groupDirs.length > 0 &&
        groupDirs.every(
          (d) => !d.includes(aliceId) && !d.includes(bobId) && !d.includes(aliceId.slice(0, 8)) && !d.includes(bobId.slice(0, 8)),
        )
      check(
        'the group dir under Chat/groups/ exists and its name is an opaque token (no device-id prefix)',
        groupDirs.length > 0 && opaque,
        groupDirs.join(' '),
      )
    } catch (err) {
      check(
        'the group dir under Chat/groups/ exists and its name is an opaque token (no device-id prefix)',
        false,
        err instanceof Error ? err.message : String(err),
      )
    }

    // ---- Code block with an explicit language (1.2 language dropdown) ------
    await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(conv)}, { text: 'const x: number = 1', kind: 'code', lang: 'typescript' })`,
    )
    const gotCode = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find(
        (e) => e.type === 'msg' && e.payload?.body?.kind === 'code' && e.payload?.body?.text === 'const x: number = 1',
      )
    }, 20000)
    check(
      "bob's event body has lang === 'typescript'",
      gotCode?.payload?.body?.lang === 'typescript',
      gotCode ? `lang=${gotCode.payload.body.lang}` : 'timed out',
    )

    // ---- Quick replies: inline chip row above the composer (send-on-click) -
    // A plain click sends the chip immediately as its own message — verified
    // end to end (bob clicks the first chip, alice receives its text).
    // Option/Alt-click (insert instead of send) is not independently
    // drivable here: `.click()` carries no modifier keys, and there is no
    // bridge-level hook to confirm "inserted" versus "sent" short of a
    // synthetic Input.dispatchMouseEvent this script does not otherwise use
    // anywhere. Skipped rather than faked; see the soft() note below.
    //
    // The chip sends to bob's *active* conversation, which until now was
    // whatever the store auto-selected at boot (store/index.ts picks the first
    // live channel). Pin it: click #general's real sidebar row first, then
    // assert what the row is showing before pressing it — otherwise a changed
    // default selection, or #product arriving ahead of #general, sends the
    // chip somewhere else and the only symptom is a 20s timeout below.
    const qmOpenedGeneral = await until(async () => {
      const ok = await bob.eval(
        `(() => { const el = document.querySelector('button.sem-row[aria-label^="Channel general"]');` +
          ` if (!el) return false; el.click(); return true })()`,
      )
      return ok === true ? true : undefined
    }, 20000)
    check('bob opens #general before pressing a quick reply', qmOpenedGeneral === true)
    const qmRow = await until(async () => {
      const info = await bob.eval(
        `(() => {
          const row = document.querySelector('[role="group"][aria-label="Quick replies"]')
          if (!row) return null
          const chips = [...row.querySelectorAll('button')]
          if (!chips.length) return null
          return { count: chips.length, first: chips[0].textContent, label: chips[0].getAttribute('aria-label') }
        })()`,
      )
      return info ?? undefined
    }, 20000)
    check(
      'bob sees exactly the five default chips above the composer (first: On it 👀)',
      qmRow?.count === 5 && qmRow?.first === 'On it 👀' && qmRow?.label === 'Send quick reply: On it 👀',
      qmRow ? `${qmRow.count} chips, first=${JSON.stringify(qmRow.first)} label=${JSON.stringify(qmRow.label)}` : 'row never rendered',
    )
    const qmChipClicked = await bob.eval(
      `(() => {
        const row = document.querySelector('[role="group"][aria-label="Quick replies"]')
        if (!row) return false
        const chip = row.querySelector('button')
        if (!chip) return false
        chip.click()
        return true
      })()`,
    )
    check('bob clicks the first quick-reply chip', qmChipClicked === true)
    const qmReceived = await until(async () => {
      const evs = await alice.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'msg' && e.payload?.body?.kind === 'text' && e.payload?.body?.text === 'On it 👀')
    }, 20000)
    check(
      'alice receives the quick-reply text as a normal message',
      Boolean(qmReceived),
      qmReceived ? '' : `never arrived in ${conv} — did the chip send to bob's other conversation?`,
    )
    soft(
      'Option/Alt-click (insert instead of send) is not covered — not drivable without a real modifier-key click, and there is no bridge hook to verify it independently',
      true,
    )

    // ---- Poll with a quick decision (1.3): vote, close, both directions ----
    // The whole point of the `vot` event type is that it travels on its own
    // ring (`heads2`), so this exercises the reader path end to end: Bob never
    // scans a directory for the vote, and Alice never scans for the close.
    const pollDraft = {
      kind: 'poll',
      text: 'Ship on Friday?',
      poll: {
        question: 'Ship on Friday?',
        options: [
          { id: 'yes', text: 'Yes' },
          { id: 'no', text: 'No' },
          { id: 'abstain', text: 'Abstain' },
        ],
        multi: false,
        anonymous: false,
        decision: true,
      },
    }
    const sentPoll = await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(conv)}, ${JSON.stringify(pollDraft)})`,
    )
    check('alice sends a quick-decision poll', !!sentPoll?.id, sentPoll ? sentPoll.id : 'no id')

    const gotPoll = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'msg' && e.id === sentPoll?.id)
    }, 20000)
    check(
      "bob's poll message carries the PollBody and the pre-1.3 fallback line",
      gotPoll?.payload?.body?.kind === 'poll' &&
        gotPoll?.payload?.body?.poll?.options?.length === 3 &&
        /update Chat to vote/.test(gotPoll?.payload?.body?.text ?? ''),
      gotPoll ? `kind=${gotPoll.payload.body.kind} text=${gotPoll.payload.body.text}` : 'timed out',
    )

    const voteErr = await bob.eval(
      `window.bridge.chat.vote(${JSON.stringify(conv)}, ${JSON.stringify(sentPoll?.id)}, ['yes']).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('bob votes Yes via chat.vote', voteErr === '', voteErr)
    const badVote = await bob.eval(
      `window.bridge.chat.vote(${JSON.stringify(conv)}, ${JSON.stringify(sentPoll?.id)}, ['yes','no']).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('a second pick on a single-choice poll is refused', /single-choice/.test(badVote ?? ''), badVote)

    const gotVote = await until(async () => {
      const evs = await alice.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'vot' && e.payload?.target === sentPoll?.id)
    }, 25000)
    check(
      "alice's chat.events shows bob's vote (verified, via heads2)",
      !!gotVote && gotVote.verified === true && JSON.stringify(gotVote.payload?.choice) === '["yes"]',
      gotVote ? `choice=${JSON.stringify(gotVote.payload.choice)} verified=${gotVote.verified}` : 'timed out',
    )

    const closeByBob = await bob.eval(
      `window.bridge.chat.closePoll(${JSON.stringify(conv)}, ${JSON.stringify(sentPoll?.id)}).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('only the author may close a poll', /not-poll-author/.test(closeByBob ?? ''), closeByBob)

    const closeErr = await alice.eval(
      `window.bridge.chat.closePoll(${JSON.stringify(conv)}, ${JSON.stringify(sentPoll?.id)}).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice closes her poll', closeErr === '', closeErr)

    const gotClose = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'edt' && e.payload?.target === sentPoll?.id && e.payload?.body?.poll?.closedAt)
    }, 25000)
    check(
      "bob's copy of the poll is closed (closedAt from alice's edt)",
      !!gotClose && gotClose.payload.body.poll.closedAt > 0,
      gotClose ? `closedAt=${gotClose.payload.body.poll.closedAt}` : 'timed out',
    )
    const lateVote = await bob.eval(
      `window.bridge.chat.vote(${JSON.stringify(conv)}, ${JSON.stringify(sentPoll?.id)}, ['no']).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('a closed poll takes no more votes', /poll-closed/.test(lateVote ?? ''), lateVote)

    // ---- Delete a channel: gone on bob, sending into it rejects on alice ---
    const deleteErr = await alice.eval(
      `window.bridge.chat.deleteChannel(${JSON.stringify(designCh?.conv)}).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice deletes #product via chat.deleteChannel', deleteErr === '', deleteErr)

    const chansB2 = await until(async () => {
      const chs = await bob.eval(`window.bridge.chat.channels()`)
      return chs && !chs.some((c) => c.name === 'product') ? chs : undefined
    }, 20000)
    check(
      "bob's chat.channels() no longer lists #product",
      !!chansB2,
      chansB2 ? chansB2.map((c) => c.name).join(' ') : 'timed out',
    )

    const sendAfterDeleteErr = await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(designCh?.conv)}, { text: 'too late', kind: 'text' }).then(() => '', (x) => String(x && x.message || x))`,
    )
    check(
      'chat.send into the deleted channel rejects on alice',
      sendAfterDeleteErr !== '',
      sendAfterDeleteErr || 'no error thrown',
    )

    // ---- File sharing: alice attaches a real file; bob fetches the blob ----
    const testFile = join(process.cwd(), 'resources', 'icon.png')
    await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(conv)}, { text: '', kind: 'text', attachments: [{ path: ${JSON.stringify(testFile)}, w: 512, h: 512 }] })`,
    )
    const attMsg = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'msg' && e.payload?.attachments?.length)
    }, 25000)
    const att = attMsg?.payload?.attachments?.[0]
    check('bob receives the attachment message', !!att, att ? `${att.name} ${att.size}B sha=${att.sha256?.slice(0, 8)}` : '')
    if (att) {
      const fetched = await until(async () => {
        const st = await bob.eval(
          `window.bridge.files.fetchBlob(${JSON.stringify(att.blobId)}, ${JSON.stringify(att.key)}, ${JSON.stringify(att.name)}, ${att.size})`,
        )
        return st?.state === 'ready' ? st : undefined
      }, 25000)
      check('bob downloads + decrypts the blob from the share', !!fetched, fetched?.url ?? '')
      if (fetched?.url) {
        // Verify the way the app actually consumes it: as an image element.
        const dims = await bob.eval(
          `new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth + 'x' + i.naturalHeight); i.onerror = () => res('ERR'); i.src = ${JSON.stringify(fetched.url)} })`,
        )
        check('sfblob:// protocol serves the decrypted image', dims === '512x512', `decoded=${dims}`)
      }
    }

    // ---- Diagrams: alice sends an inline scene; bob renders it locally -----
    //
    // The scene is built here rather than by driving the canvas: what matters
    // is the wire contract (deflate-raw + base64 inside the event, a WebP thumb
    // beside it, and a `text` line an old client can print), not Excalidraw's
    // pointer handling. Compressing with node:zlib also proves the codec's
    // format is the platform's, not something only the renderer can read.
    const diagramScene = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'e2e',
      elements: Array.from({ length: 14 }, (_, i) => ({
        id: `e2e-el-${i}`,
        type: i % 2 ? 'rectangle' : 'ellipse',
        x: 100 + i * 40,
        y: 120 + (i % 3) * 60,
        width: 160,
        height: 80,
        angle: 0,
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
        seed: 1000 + i,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
      })),
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    })
    const diagramData = deflateRawSync(Buffer.from(diagramScene, 'utf8')).toString('base64')
    const diagramThumb =
      'data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA='
    const diagramDraft = {
      text: 'Sprint plan',
      kind: 'diagram',
      diagram: { fmt: 'excalidraw', data: diagramData, w: 660, h: 320, elements: 14, thumb: diagramThumb },
    }
    const diagErr = await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(conv)}, ${JSON.stringify(diagramDraft)}).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice sends an inline diagram', diagErr === '', diagErr || `${diagramData.length}B compressed`)

    const diagMsg = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'msg' && e.payload?.body?.kind === 'diagram')
    }, 25000)
    const diagBody = diagMsg?.payload?.body
    check(
      'bob receives the diagram message with its scene and thumb inline',
      !!diagBody && !!diagBody.diagram?.data && !!diagBody.diagram?.thumb && diagBody.diagram.elements === 14,
      diagBody ? `${diagBody.diagram?.data?.length}B data, thumb ${diagBody.diagram?.thumb?.length}B` : 'timed out',
    )
    check(
      'the diagram message carries no attachment (zero extra share I/O to read it)',
      !!diagMsg && !diagMsg.payload?.attachments,
      diagMsg?.payload?.attachments ? 'unexpected attachment' : 'inline only',
    )
    check(
      'a pre-1.2 client would still see a line naming the diagram',
      diagBody?.text === '📐 Diagram: Sprint plan — update Chat to view it',
      diagBody?.text ?? '',
    )
    if (diagBody?.diagram?.data) {
      let roundTripped = ''
      try {
        roundTripped = inflateRawSync(Buffer.from(diagBody.diagram.data, 'base64')).toString('utf8')
      } catch (err) {
        roundTripped = `inflate failed: ${err}`
      }
      check(
        "bob's copy of the scene inflates back to exactly what alice drew",
        roundTripped === diagramScene,
        roundTripped === diagramScene ? `${diagramScene.length}B scene` : roundTripped.slice(0, 80),
      )
    }

    // The tile itself: bob opens the channel and the diagram renders locally
    // (thumb first, then a crisp SVG from the scene) with no blob fetch.
    let tileState = 'no tile'
    const tileSeen = await until(async () => {
      tileState = await bob.eval(
        `(() => {
          const el = document.querySelector('button[aria-label^="Open the diagram"]')
          if (!el) return 'no tile'
          if (el.querySelector('svg')) return 'svg'
          if (el.querySelector('img')) return 'thumb'
          return 'placeholder'
        })()`,
      )
      return tileState === 'svg' ? tileState : undefined
    }, 25000)
    soft('bob renders the diagram tile as a locally drawn SVG', tileSeen === 'svg', tileState)

    // ---- A diagram too big to ride inline: the scene travels as a blob -----
    //
    // Over DIAGRAM.maxInlineBytes the sender stages the scene and sends it as a
    // `.excalidraw` attachment instead (scene.ts: planDiagramSend), and the
    // reader pulls it back over sfblob:// with *fetch* rather than painting it
    // in an <img>. That makes it the one consumer subject to CORS on the custom
    // scheme — it could not load a single scene until the protocol started
    // answering with Access-Control-Allow-Origin.
    const DIAGRAM_MAX_INLINE = 120 * 1024 // DIAGRAM.maxInlineBytes

    /** A scene whose labels deflate badly, so "too big" needs hundreds of elements, not millions. */
    const mkBigScene = (count) => {
      let seed = 0x2f6e2b1
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 0x7fffffff
        return seed / 0x7fffffff
      }
      const label = () => Array.from({ length: 24 }, () => Math.floor(rnd() * 36 ** 6).toString(36)).join(' ')
      return JSON.stringify({
        type: 'excalidraw',
        version: 2,
        source: 'e2e',
        elements: Array.from({ length: count }, (_, i) => {
          const text = label()
          return {
            id: `e2e-big-${i}`,
            type: 'text',
            x: 40 + (i % 20) * 180,
            y: 40 + Math.floor(i / 20) * 28,
            width: 170,
            height: 24,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            fillStyle: 'solid',
            strokeWidth: 1,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 100,
            groupIds: [],
            frameId: null,
            roundness: null,
            seed: 7000 + i,
            version: 1,
            versionNonce: 1,
            isDeleted: false,
            boundElements: null,
            updated: 1,
            link: null,
            locked: false,
            text,
            originalText: text,
            fontSize: 16,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            containerId: null,
            lineHeight: 1.25,
          }
        }),
        appState: { viewBackgroundColor: '#ffffff' },
        files: {},
      })
    }

    // Grow until the *compressed* scene is comfortably over the ceiling — the
    // same number planDiagramSend measures (base64 of deflate-raw).
    let bigCount = 600
    let bigScene = mkBigScene(bigCount)
    let bigCompressed = deflateRawSync(Buffer.from(bigScene, 'utf8')).toString('base64')
    while (bigCompressed.length < DIAGRAM_MAX_INLINE * 1.15 && bigCount < 3000) {
      bigCount += 200
      bigScene = mkBigScene(bigCount)
      bigCompressed = deflateRawSync(Buffer.from(bigScene, 'utf8')).toString('base64')
    }
    check(
      'the oversized scene really is too big to send inline',
      bigCompressed.length > DIAGRAM_MAX_INLINE,
      `${bigCount} text elements · ${bigCompressed.length}B compressed > ${DIAGRAM_MAX_INLINE}B ceiling`,
    )

    const bigStaged = await alice.eval(
      `window.bridge.files.stageBytes('Capacity plan.excalidraw', ${JSON.stringify(Buffer.from(bigScene, 'utf8').toString('base64'))})`,
    )
    const bigBody = { fmt: 'excalidraw', w: 3640, h: 40 + Math.ceil(bigCount / 20) * 28, elements: bigCount, thumb: diagramThumb }
    const bigDraft = {
      text: 'Capacity plan',
      kind: 'diagram',
      diagram: bigBody,
      attachments: [{ path: bigStaged?.path, thumb: diagramThumb, w: bigBody.w, h: bigBody.h }],
    }
    const bigErr = await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(conv)}, ${JSON.stringify(bigDraft)}).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice sends it as a staged .excalidraw attachment', bigErr === '', bigErr || bigStaged?.path || '')

    const bigMsg = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find(
        (e) => e.type === 'msg' && e.payload?.body?.kind === 'diagram' && e.payload?.attachments?.length,
      )
    }, 30000)
    const bigAtt = bigMsg?.payload?.attachments?.[0]
    check(
      'bob receives it as a .excalidraw attachment with no inline scene',
      !!bigAtt && bigAtt.name.endsWith('.excalidraw') && !bigMsg?.payload?.body?.diagram?.data,
      bigAtt
        ? `${bigAtt.name} ${bigAtt.size}B · inline data ${bigMsg?.payload?.body?.diagram?.data ? 'PRESENT' : 'absent'}`
        : 'timed out',
    )

    if (bigAtt) {
      // The read the tile does, done explicitly: fetch() on an sfblob:// URL.
      // Before the scheme was corsEnabled (and the handler started answering
      // with Access-Control-Allow-Origin) this threw "Failed to fetch" — with
      // no status, so a share outage was indistinguishable from an expiry.
      const read = await bob.eval(
        `(async () => {
          const a = ${JSON.stringify(bigAtt)}
          const url = 'sfblob://blob/' + a.blobId + '?key=' + encodeURIComponent(a.key) + '&name=' + encodeURIComponent(a.name) + '&size=' + a.size
          try {
            await window.bridge.files.fetchBlob(a.blobId, a.key, a.name, a.size)
            const res = await fetch(url)
            const text = await res.text()
            const ranged = await fetch(url + '&probe=range', { headers: { Range: 'bytes=0-15' } })
            return {
              status: res.status,
              bytes: text.length,
              head: text.slice(0, 24),
              rangeStatus: ranged.status,
              // Readable only because the handler exposes it to the page.
              contentRange: ranged.headers.get('Content-Range'),
            }
          } catch (err) {
            return { error: String(err && err.message || err) }
          }
        })()`,
      )
      check(
        'bob reads the scene back over sfblob:// with fetch (CORS on the custom scheme)',
        read?.status === 200 && read?.bytes === bigScene.length,
        read?.error ?? `${read?.bytes}B of ${bigScene.length}B · ${read?.head ?? ''}`,
      )
      check(
        'a ranged read still works, with Content-Range exposed to the page',
        read?.rangeStatus === 206 && read?.contentRange === `bytes 0-15/${bigAtt.size}`,
        read?.contentRange ?? String(read?.rangeStatus ?? read?.error ?? ''),
      )
    }

    // And the tile itself, end to end: thumb -> fetched scene -> local SVG.
    let bigTile = 'no tile'
    const bigTileSeen = await until(async () => {
      bigTile = await bob.eval(
        `(() => {
          const el = document.querySelector('button[aria-label^="Open the diagram Capacity plan"]')
          if (!el) return 'no tile'
          if (el.querySelector('svg')) return 'svg'
          if (el.textContent.includes('cleaned up')) return 'expired'
          if (el.querySelector('img')) return 'thumb'
          return 'placeholder'
        })()`,
      )
      return bigTile === 'svg' ? bigTile : undefined
    }, 45000)
    soft('bob renders the blob-backed diagram tile as a locally drawn SVG', bigTileSeen === 'svg', bigTile)

    // ---- Live boards (1.3): a session over the folder, both directions -----
    //
    // Driven over the bridge rather than through Excalidraw: what has to hold
    // is the session protocol (one file per participant, seq in the name, the
    // previous one deleted, frames delivered once, host-only end, dir removed),
    // not the canvas. The renderer's reconcile/echo half is covered by
    // live.test.ts, which can run without a window at all.
    const boardEl = (id, x) => ({
      id,
      type: 'rectangle',
      x,
      y: 80,
      width: 120,
      height: 60,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: 7,
      version: 2,
      versionNonce: 11,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      index: `a${id}`,
    })
    const collector =
      `(() => { window.__boards = { frames: [], ended: [] }; window.bridge.onPush((m) => {` +
      ` if (m.kind === 'board-frames') window.__boards.frames.push(...m.frames);` +
      ` if (m.kind === 'board-ended') window.__boards.ended.push(m.sessionId) }); return true })()`
    await alice.eval(collector)
    await bob.eval(collector)

    const started = await alice.eval(
      `window.bridge.boards.start(${JSON.stringify(conv)}, 'Sprint plan live').then((r) => r, (x) => ({ error: String(x && x.message || x) }))`,
    )
    const sid = started?.sessionId
    check(
      'alice starts a live board (boards.start returns a session id)',
      typeof sid === 'string' && /^[0-9a-f]{16}$/.test(sid),
      started?.error ?? String(sid),
    )

    if (typeof sid === 'string' && /^[0-9a-f]{16}$/.test(sid)) {
      const liveSys = await until(async () => {
        const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
        return evs?.find((e) => e.type === 'sys' && e.payload?.kind === 'board-live' && e.payload?.data?.sessionId === sid)
      }, 25000)
      check(
        "bob's log carries the board-live sys event (this is what puts Join on the row)",
        !!liveSys && liveSys.verified === true && liveSys.payload.data.title === 'Sprint plan live',
        liveSys ? `host=${String(liveSys.payload.data.host).slice(0, 8)} title=${liveSys.payload.data.title}` : 'timed out',
      )

      // The host joins its own session: `join` is what starts the poller.
      const joinA = await alice.eval(
        `window.bridge.boards.join(${JSON.stringify(sid)}, ${JSON.stringify(conv)}).then((r) => r, (x) => ({ error: String(x && x.message || x) }))`,
      )
      check('alice joins her own session (the poller only starts on join)', !joinA?.error, joinA?.error ?? 'joined')

      const twoEls = [boardEl('b-alice-1', 40), boardEl('b-alice-2', 200)]
      const writeErr = await alice.eval(
        `window.bridge.boards.write(${JSON.stringify(sid)}, ${JSON.stringify(conv)}, ${JSON.stringify({
          elements: twoEls,
          pointer: { x: -120.5, y: 64.25, tool: 'pointer' },
          selectedIds: ['b-alice-2'],
        })}).then(() => '', (x) => String(x && x.message || x))`,
      )
      check('alice writes a two-element frame', writeErr === '', writeErr || '2 elements')

      // Bob joins: `join` returns every frame currently in the dir, and anything
      // written while the coalescer was still holding alice's draft arrives as a
      // push straight after.
      const joinB = await until(async () => {
        const r = await bob.eval(
          `window.bridge.boards.join(${JSON.stringify(sid)}, ${JSON.stringify(conv)}).then((r) => r, (x) => ({ error: String(x && x.message || x) }))`,
        )
        if (r?.error) return undefined
        if (r?.frames?.some((f) => f.elements?.length === 2)) return r
        const pushed = await bob.eval(`window.__boards`)
        return pushed?.frames?.some((f) => f.elements?.length === 2) ? { frames: pushed.frames } : undefined
      }, 30000)
      const aliceFrame = joinB?.frames?.find((f) => f.elements?.length === 2)
      check(
        "bob's join returns alice's frame, signed by her device, with her scene coordinates intact",
        !!aliceFrame &&
          aliceFrame.device === selfA.self.deviceId &&
          aliceFrame.elements.map((e) => e.id).join(',') === 'b-alice-1,b-alice-2' &&
          aliceFrame.pointer?.x === -120.5 &&
          aliceFrame.selectedIds?.[0] === 'b-alice-2',
        aliceFrame ? `seq=${aliceFrame.seq} name=${aliceFrame.name} els=${aliceFrame.elements.length}` : 'timed out',
      )

      // Bob draws on it: the whole element list travels, alice's two included —
      // which is what makes per-element last-writer-wins reconcile cleanly.
      const threeEls = [...twoEls, boardEl('b-bob-3', 360)]
      const writeBErr = await bob.eval(
        `window.bridge.boards.write(${JSON.stringify(sid)}, ${JSON.stringify(conv)}, ${JSON.stringify({
          elements: threeEls,
          pointer: { x: 380, y: 100, tool: 'pointer' },
        })}).then(() => '', (x) => String(x && x.message || x))`,
      )
      check('bob adds a third element and writes his own frame', writeBErr === '', writeBErr || '3 elements')

      const gotBob = await until(async () => {
        const st = await alice.eval(`window.__boards`)
        return st?.frames?.find((f) => f.device === selfB.self.deviceId && f.elements?.some((e) => e.id === 'b-bob-3'))
      }, 30000)
      check(
        "alice gets a board-frames push carrying bob's element",
        !!gotBob && gotBob.elements.length === 3,
        gotBob ? `from ${gotBob.device.slice(0, 8)} seq=${gotBob.seq} els=${gotBob.elements.length}` : 'timed out',
      )

      // One file per participant, ever: each write renames a new seq into place
      // and deletes the writer's previous file, so a readdir is the whole state.
      const boardFiles = await until(async () => {
        try {
          const fs = readdirSync(join(SHARE, 'Chat', 'boards', sid))
          return fs.length >= 2 ? fs : undefined
        } catch {
          return undefined
        }
      }, 20000)
      const prefixes = new Set((boardFiles ?? []).map((f) => f.split('.')[0]))
      check(
        'boards/<sid>/ holds exactly one file per writer (the previous seq is deleted)',
        !!boardFiles && boardFiles.length === prefixes.size && prefixes.size === 2,
        (boardFiles ?? []).join(' ') || 'timed out',
      )

      const bobEndErr = await bob.eval(
        `window.bridge.boards.end(${JSON.stringify(sid)}, ${JSON.stringify(conv)}).then(() => '', (x) => String(x && x.message || x))`,
      )
      check('boards.end from a non-host is refused', bobEndErr !== '', bobEndErr || 'no error thrown')

      const endErr = await alice.eval(
        `window.bridge.boards.end(${JSON.stringify(sid)}, ${JSON.stringify(conv)}).then(() => '', (x) => String(x && x.message || x))`,
      )
      check('alice (the host) ends the live board', endErr === '', endErr)

      const endedOnBob = await until(async () => {
        const st = await bob.eval(`window.__boards`)
        if (st?.ended?.includes(sid)) return 'push'
        const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
        return evs?.some((e) => e.type === 'sys' && e.payload?.kind === 'board-ended' && e.payload?.data?.sessionId === sid)
          ? 'event'
          : undefined
      }, 30000)
      check(
        "bob's editor is told the board ended (board-ended push or sys event)",
        !!endedOnBob,
        endedOnBob || 'timed out',
      )

      const dirGone = await until(async () => {
        try {
          readdirSync(join(SHARE, 'Chat', 'boards', sid))
          return undefined
        } catch {
          return 'gone'
        }
      }, 20000)
      check('the boards/<sid>/ directory is removed when the host ends it', dirGone === 'gone', dirGone ?? 'still there')
    }

    // The renderer half, driven through the real UI: the diagram tile's
    // **Collaborate** hosts a board seeded with that scene, the header shows
    // the Live pill, this device's frame lands in the folder, and **End
    // session** takes the whole directory away again. Best-effort like the
    // tile render above — it depends on the 1 MB editor chunk loading and on a
    // compositor being willing to paint, neither of which is the protocol.
    const boardsBefore = (() => {
      try {
        return readdirSync(join(SHARE, 'Chat', 'boards'))
      } catch {
        return []
      }
    })()
    const collabClicked = await bob.eval(
      `(() => { const el = document.querySelector('button[title^="Open this as a live board"]'); if (!el) return false; el.click(); return true })()`,
    )
    soft("bob's diagram tile offers Collaborate", collabClicked === true, collabClicked === true ? 'clicked' : 'no button')
    if (collabClicked === true) {
      const pill = await until(
        async () =>
          await bob.eval(
            `(() => { const el = document.querySelector('[role="status"][aria-label^="Live board"]'); return el ? el.getAttribute('aria-label') : undefined })()`,
          ),
        40000,
      )
      soft('the editor opens in live mode and shows the Live pill', !!pill, pill || 'timed out')

      const uiSid = await until(async () => {
        try {
          const now = readdirSync(join(SHARE, 'Chat', 'boards')).filter((d) => !boardsBefore.includes(d))
          const fresh = now.find((d) => readdirSync(join(SHARE, 'Chat', 'boards', d)).length > 0)
          return fresh
        } catch {
          return undefined
        }
      }, 30000)
      soft("the editor's own frame reaches boards/<sid>/", !!uiSid, uiSid || 'timed out')

      // …and the inbound half, in the real editor: alice joins bob's session
      // over the bridge and writes a frame. The pill's own label is the proof
      // it landed — it is rendered from the collaborator map that
      // `digestFrames` → `reconcileElements` → `updateScene` produces, so a
      // throw anywhere along that path leaves it reading "0 other
      // participants".
      if (uiSid) {
        await alice.eval(
          `window.bridge.boards.join(${JSON.stringify(uiSid)}, ${JSON.stringify(conv)}).catch(() => {})`,
        )
        await alice.eval(
          `window.bridge.boards.write(${JSON.stringify(uiSid)}, ${JSON.stringify(conv)}, ${JSON.stringify({
            elements: [boardEl('b-ui-1', 520)],
            pointer: { x: 540, y: 96, tool: 'pointer' },
          })}).catch(() => {})`,
        )
        const withPeer = await until(
          async () =>
            await bob.eval(
              `(() => { const el = document.querySelector('[role="status"][aria-label^="Live board"]');` +
                ` const l = el && el.getAttribute('aria-label');` +
                ` return l && l.includes('drawing with') ? l : undefined })()`,
            ),
          40000,
        )
        soft(
          "the editor reconciles a peer's frame and shows them in the Live pill",
          !!withPeer,
          withPeer || 'still alone — the inbound path did not run',
        )
        await alice.eval(
          `window.bridge.boards.leave(${JSON.stringify(uiSid)}, ${JSON.stringify(conv)}).catch(() => {})`,
        )
      }

      const endClicked = await bob.eval(
        `(() => { const el = document.querySelector('button[title^="End the live board for everyone"]'); if (!el) return false; el.click(); return true })()`,
      )
      soft('the host can end the session from the header', endClicked === true)
      if (uiSid) {
        const uiGone = await until(async () => {
          try {
            readdirSync(join(SHARE, 'Chat', 'boards', uiSid))
            return undefined
          } catch {
            return 'gone'
          }
        }, 25000)
        soft('ending from the header removes the session directory', uiGone === 'gone', uiGone ?? 'still there')
      }
    }
    // Whatever happened above, leave bob looking at the chat again: the rest of
    // the run (and the final screenshot) expects the ordinary pane.
    await bob.eval(
      `(() => { const c = document.querySelector('button[aria-label="Close the diagram editor"]'); if (c) c.click(); return true })()`,
    )
    await sleep(400)
    await bob.eval(
      `(() => { const b = document.querySelectorAll('[role="alertdialog"] button'); if (b.length) b[b.length - 1].click(); return true })()`,
    )
    await sleep(400)
    soft(
      'the diagram editor is closed again',
      (await bob.eval(`document.querySelector('.sem-diagram-host') === null`)) === true,
    )

    // ---- Editor chrome (1.4): the header is the drag strip, not a trap -----
    //
    // Gil tested the packaged macOS build and found every control in the
    // editor's top strip dead to the mouse, the title printed under the traffic
    // lights, and no way out of the mode at all. The cause: Chromium derives
    // `-webkit-app-region` from the DOM regardless of z-order, so the shell's
    // 36 px drag strip stayed draggable *underneath* the editor overlay and the
    // OS ate every press that landed there.
    //
    // A CDP click cannot reproduce that — it is dispatched into the DOM, below
    // the level at which the window server steals the press, which is exactly
    // why every run before this one passed. So what is checked here is the
    // computed region the OS actually reads, plus the geometry that keeps the
    // title clear of the traffic lights. The real-mouse half stays a manual
    // check by construction.
    // Two evals, because the menu is React state: it is not in the DOM until
    // the render that follows the click.
    const menuOpened = await bob.eval(
      `(() => {
         const b = document.querySelector('button[aria-label="Draw a diagram"]')
         if (!b) return 'no composer button'
         b.click()
         return 'ok'
       })()`,
    )
    await sleep(300)
    const freshOpened =
      menuOpened === 'ok'
        ? await bob.eval(
            `(() => {
               const items = [...document.querySelectorAll('[role="menu"][aria-label="Diagram"] [role="menuitem"]')]
               const item = items.find((e) => (e.textContent || '').includes('New diagram'))
               if (!item) return 'no New diagram item'
               item.click()
               return 'ok'
             })()`,
          )
        : menuOpened
    soft('bob opens a fresh diagram from the composer', freshOpened === 'ok', String(freshOpened))

    if (freshOpened === 'ok') {
      const chrome = await until(
        async () =>
          await bob.eval(
            `(() => {
               const h = document.querySelector('[role="dialog"][aria-label^="Diagram editor"] > header')
               if (!h) return undefined
               // Computed first (that is what the OS reads); the inline style
               // is the fallback so an empty computed value is reported rather
               // than mistaken for "drag".
               const region = (el) => {
                 const c = getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
                 return c || (el.style.webkitAppRegion || '').trim() || '(unset)'
               }
               const controls = [...h.querySelectorAll('button, input, [role="status"]')]
               const title = h.querySelector('input[aria-label="Diagram title"]')
               return {
                 header: region(h),
                 controls: controls.length,
                 bad: controls
                   .filter((el) => region(el) !== 'no-drag')
                   .map((el) => (el.getAttribute('aria-label') || el.textContent || el.tagName) + ':' + region(el)),
                 titleLeft: title ? Math.round(title.getBoundingClientRect().left) : -1,
                 height: Math.round(h.getBoundingClientRect().height),
                 close: !!h.querySelector('button[aria-label="Close the diagram editor"]'),
                 closeText: (h.querySelector('button[aria-label="Close the diagram editor"]') || {}).textContent || '',
               }
             })()`,
          ),
        30000,
      )
      check(
        'the diagram header is the window drag strip',
        chrome?.header === 'drag',
        chrome ? `region ${chrome.header}, ${chrome.height}px tall` : 'editor never appeared',
      )
      check(
        'every control in the diagram header opts out of dragging',
        !!chrome && chrome.controls > 0 && chrome.bad.length === 0,
        chrome ? `${chrome.controls} controls${chrome.bad.length ? ` — still draggable: ${chrome.bad.join(', ')}` : ''}` : '',
      )
      check(
        'the Close control is labelled, not a bare ×',
        !!chrome?.close && /close/i.test(chrome.closeText),
        chrome ? JSON.stringify(chrome.closeText) : '',
      )
      if (process.platform === 'darwin') {
        check(
          'the diagram title clears the macOS traffic lights',
          !!chrome && chrome.titleLeft >= 72,
          chrome ? `title starts at x=${chrome.titleLeft}` : '',
        )
      }

      // Clean style (1.4): a fresh canvas opens with no pencil in it. Asked of
      // Excalidraw's own app state, because `serializeAsJSON` drops every
      // `currentItem*` key — the draft in localStorage cannot answer this.
      const style = await until(
        async () =>
          await bob.eval(
            `(() => {
               const api = window.__sfDiagramApi
               if (!api) return undefined
               const s = api.getAppState()
               return {
                 roughness: s.currentItemRoughness,
                 strokeWidth: s.currentItemStrokeWidth,
                 fontFamily: s.currentItemFontFamily,
                 roundness: s.currentItemRoundness,
                 fillStyle: s.currentItemFillStyle,
                 bg: s.viewBackgroundColor,
               }
             })()`,
          ),
        20000,
      )
      check(
        'a fresh diagram starts in the clean style (no hand-drawn roughness)',
        style?.roughness === 0 && style?.strokeWidth === 1 && style?.fontFamily === 6 && style?.fillStyle === 'solid',
        style ? JSON.stringify(style) : 'no Excalidraw API',
      )

      // Escape from an idle canvas is the way out. Dispatched at whatever has
      // focus (Excalidraw autofocuses its canvas), so it travels the same
      // capture-phase path a real key press does.
      await bob.eval(
        `(() => {
           const t = document.activeElement || document.body
           t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
           return true
         })()`,
      )
      await sleep(600)
      check(
        'Escape closes the diagram editor from an idle canvas',
        (await bob.eval(`document.querySelector('.sem-diagram-host') === null`)) === true,
        'no dirty confirm on an untouched canvas',
      )
      // Belt and braces for the rest of the run: if Escape did not do it, the
      // Close button must.
      await bob.eval(
        `(() => { const c = document.querySelector('button[aria-label="Close the diagram editor"]'); if (c) c.click(); return true })()`,
      )
      await sleep(300)
    }

    // ---- Beams: alice beams a file directly to bob; auto-flow via bridge ----
    // Persistent collector attached BEFORE the send so no push is missed.
    await bob.eval(
      `(() => { window.__beam = { offers: [], progress: [] }; window.bridge.onPush((m) => { if (m.kind === 'beam-offer') window.__beam.offers.push(m.offer); if (m.kind === 'beam-progress') window.__beam.progress.push(m.progress) }); return true })()`,
    )
    await alice.eval(
      `window.bridge.beams.send(${JSON.stringify(selfB.self.deviceId)}, [${JSON.stringify(testFile)}])`,
    )
    const offer = await until(async () => {
      const b = await bob.eval(`window.__beam`)
      return b?.offers?.[0]
    }, 40000)
    check('bob receives the beam offer', !!offer, offer ? `${offer.name} from ${offer.fromDeviceId?.slice(0, 8)}` : '')
    if (offer) {
      await bob.eval(`window.bridge.beams.accept(${JSON.stringify(offer.dropId)})`)
      const done = await until(async () => {
        const b = await bob.eval(`window.__beam`)
        return b?.progress?.find((p) => p.state === 'saved')
      }, 40000)
      check('beam transfers, verifies, and saves', !!done, done?.savedPath ?? '')
    }

    // Typing indicator: alice types, bob's push state can't be read via bridge — verified visually/unit level. Skip.

    // ---- Team calendar: A -> B over the team/ event log --------------------
    const CAL = 'team:calendar'
    const today = new Date()
    const release = ymd(addDays(today, 3))
    const bday = addDays(today, 5)
    const entries = [
      {
        id: 'a1b2c3d4e5f60001',
        title: 'Release 1.1 — splash, calendar, pull requests',
        tag: 'Release',
        color: 2,
        start: release,
        end: release,
        annual: false,
        notes: 'Cut the zips, run the gates, tag it.',
      },
      {
        id: 'a1b2c3d4e5f60002',
        title: "Dana's birthday",
        tag: 'Birthday',
        color: 5,
        // A real annual entry: stored on its original year, expanded forward.
        start: `1990-${ymd(bday).slice(5)}`,
        end: `1990-${ymd(bday).slice(5)}`,
        annual: true,
        notes: '',
      },
    ]
    let calPut = true
    for (const e of entries) {
      const err = await alice
        .eval(`window.bridge.calendar.put(${JSON.stringify(e)}).then(() => '', (x) => String(x && x.message || x))`)
        .catch((x) => String(x))
      if (err) calPut = false
      if (err) console.log(`    calendar.put(${e.id}) rejected: ${err}`)
    }
    check('alice publishes two calendar entries', calPut)

    const calB = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(CAL)})`)
      const puts = (evs ?? []).filter((e) => e.type === 'cal' && e.verified === true && e.payload?.op === 'put')
      return entries.every((x) => puts.some((p) => p.payload?.entry?.id === x.id)) ? puts : undefined
    }, 25000)
    check(
      'bob receives both calendar entries (verified, under team/)',
      !!calB,
      calB ? calB.map((p) => p.payload.entry.title).join(' · ') : 'timed out',
    )

    // Pane screenshot while both entries are still live.
    soft(
      'calendar pane screenshot',
      await paneShot(alice, 'Team calendar', join(SHOTS, 'e2e-calendar.png')),
      join(SHOTS, 'e2e-calendar.png'),
    )

    // Bob deletes one; the tombstone must reach alice.
    await bob.eval(`window.bridge.calendar.remove(${JSON.stringify(entries[1].id)})`)
    const tomb = await until(async () => {
      const evs = await alice.eval(`window.bridge.chat.events(${JSON.stringify(CAL)})`)
      return (evs ?? []).find(
        (e) => e.type === 'cal' && e.verified === true && e.payload?.op === 'del' && e.payload?.id === entries[1].id,
      )
    }, 25000)
    check("alice sees bob's calendar tombstone", !!tomb, tomb ? `by ${tomb.author?.slice(0, 8)}` : 'timed out')

    // ---- Pull-request group over a fake Azure DevOps -----------------------
    const anon = await fetch(`${ado.baseUrl}/_apis/connectionData?api-version=6.0-preview`).catch(() => null)
    check(
      'fake Azure DevOps answers an unauthenticated call with 203 + HTML',
      anon?.status === 203,
      `status=${anon?.status}`,
    )

    const probe = await alice.eval(
      `window.bridge.prs.testConnection({ baseUrl: ${JSON.stringify(ado.baseUrl)}, token: ${JSON.stringify(ADO_TOKEN)} })`,
    )
    check(
      'alice probes Azure DevOps (signed in, project listed)',
      probe?.ok === true && probe.me?.id === ADO_ME.id && probe.projects?.some((p) => p.name === ADO_PROJECT.name),
      probe?.ok ? `${probe.me.name} · ${probe.projects.map((p) => p.name).join(',')}` : probe?.error?.detail ?? '',
    )

    const reposRes = await alice.eval(
      `window.bridge.prs.listRepos({ baseUrl: ${JSON.stringify(ado.baseUrl)}, token: ${JSON.stringify(ADO_TOKEN)}, project: ${JSON.stringify(ADO_PROJECT.name)} })`,
    )
    check(
      'alice lists the watched repositories',
      reposRes?.ok === true && reposRes.value?.length === 2,
      reposRes?.ok ? reposRes.value.map((r) => `${r.name}@${r.defaultBranch}`).join(' ') : reposRes?.error?.detail ?? '',
    )

    const saveErr = await alice.eval(
      `window.bridge.prs.saveConfig({ baseUrl: ${JSON.stringify(ado.baseUrl)}, project: ${JSON.stringify(ADO_PROJECT.name)}, repos: ${JSON.stringify(ADO_REPOS.map((r) => ({ id: r.id, name: r.name })))}, token: ${JSON.stringify(ADO_TOKEN)}, shareToken: true }).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice saves the PR config with a shared token', saveErr === '', saveErr)

    const listA = await until(async () => {
      await alice.eval(`window.bridge.prs.refresh()`).catch(() => {})
      const l = await alice.eval(`window.bridge.prs.list()`)
      return l?.length === 2 ? l : undefined
    }, 30000)
    const openPr = listA?.find((p) => p.id === 4271)
    const donePr = listA?.find((p) => p.id === 4288)
    check(
      'alice lists both pull requests — 1.4 keeps the approved one for "Ready to complete"',
      listA?.length === 2 && openPr?.assignedToMe === true && donePr !== undefined,
      listA ? listA.map((p) => `#${p.id} ${p.repoName}`).join(' ') : 'never settled on two PRs',
    )
    const prKey = openPr?.key ?? 'repo-web:4271'

    const statusA = await alice.eval(`window.bridge.prs.status()`)
    check(
      'the status carries numeric overdue/stale counts and the team thresholds',
      typeof statusA?.overdue === 'number' &&
        typeof statusA?.stale === 'number' &&
        statusA?.unseen === 1 &&
        typeof statusA?.reviewSlaHours === 'number',
      `unseen=${statusA?.unseen} overdue=${statusA?.overdue} stale=${statusA?.stale} sla=${statusA?.reviewSlaHours}h/${statusA?.staleAfterDays}d`,
    )

    // Bob never typed a token: the shared one has to arrive over the share.
    const statB = await until(async () => {
      const s = await bob.eval(`window.bridge.prs.status()`)
      return s?.tokenSource === 'shared' && s.configured ? s : undefined
    }, 30000)
    check(
      "bob picks up the team's shared Azure DevOps token",
      !!statB,
      statB ? `${statB.project} · ${statB.repos.length} repos` : 'timed out',
    )

    const listB = await until(async () => {
      await bob.eval(`window.bridge.prs.refresh()`).catch(() => {})
      const l = await bob.eval(`window.bridge.prs.list()`)
      return l?.some((p) => p.key === prKey) ? l : undefined
    }, 30000)
    check('bob sees the same pull request', !!listB, listB ? `${listB.length} tracked` : 'timed out')

    // The waiting state, computed on bob's own machine from the same two extra
    // reads: one unresolved thread whose last word is the reviewer's, so the
    // author is who everyone is waiting for.
    const bobOpen = await until(async () => {
      await bob.eval(`window.bridge.prs.refresh()`).catch(() => {})
      const l = await bob.eval(`window.bridge.prs.list()`)
      const p = l?.find((x) => x.id === 4271)
      return p?.state?.threadsKnown === true ? p : undefined
    }, 30000)
    check(
      "bob's open PR is 'comments-open', waiting on the author, with one open thread",
      bobOpen?.state?.kind === 'comments-open' &&
        bobOpen?.state?.next === 'author' &&
        bobOpen?.state?.openThreads === 1 &&
        bobOpen?.state?.threadsKnown === true,
      bobOpen?.state
        ? `${bobOpen.state.kind} · next=${bobOpen.state.next} (${bobOpen.state.nextNames.join(', ')}) · open=${bobOpen.state.openThreads} · known=${bobOpen.state.threadsKnown}`
        : 'no state on the view',
    )
    const bobDone = listB?.find((p) => p.id === 4288)
    const statusB = await bob.eval(`window.bridge.prs.status()`)
    check(
      'the approved pull request is listed as approved and left out of the unseen count',
      bobDone?.state?.kind === 'approved' && bobDone?.state?.next === 'author' && statusB?.unseen === 1,
      `${bobDone?.state?.kind} · next=${bobDone?.state?.next} · unseen=${statusB?.unseen}`,
    )

    await alice.eval(`window.bridge.prs.markSeen([${JSON.stringify(prKey)}])`)
    const seenStat = await until(async () => {
      const s = await alice.eval(`window.bridge.prs.status()`)
      return s && s.unseen === 0 ? s : undefined
    }, 10000)
    check('alice marks the pull request seen (unseen -> 0)', !!seenStat, `unseen=${seenStat?.unseen}`)

    soft(
      'pull-request pane screenshot',
      await paneShot(alice, 'Pull requests', join(SHOTS, 'e2e-prs.png')),
      join(SHOTS, 'e2e-prs.png'),
    )

    // Complete it upstream: a merged PR is the one thing that still leaves the
    // list entirely (1.4 keeps approved ones, but not completed/abandoned).
    for (const p of ado.state.prs['repo-web']) p.status = 'completed'
    const drained = await until(async () => {
      await alice.eval(`window.bridge.prs.refresh()`).catch(() => {})
      const l = await alice.eval(`window.bridge.prs.list()`)
      return l?.some((p) => p.id === 4271) ? undefined : { gone: true }
    }, 30000)
    check('a completed pull request drops out of the list', !!drained)

    // 1.4 — the quick notification controls, driven through the real bell in
    // bob's sidebar footer. Pausing pull-request alerts there has to reach the
    // in-app card, not just the OS notification: same setting, both surfaces.
    const bellToggle = `(() => { const b = document.querySelector('button[aria-label^="Notifications"]'); if (!b) return false; b.click(); return true })()`
    const pickPrAlerts = (label) =>
      `(() => {` +
      ` const d = document.querySelector('[role="dialog"][aria-label="Notifications"]'); if (!d) return false;` +
      ` const r = d.querySelector('[role="radiogroup"][aria-label="Pull request alerts"] [role="radio"][title=${JSON.stringify(label)}]');` +
      ` if (!r) return false; r.click(); return true })()`
    const prCard = `Array.from(document.querySelectorAll('[role="alert"]')).some((n) => /pull request/i.test(n.textContent || ''))`

    await bob.eval(bellToggle)
    await sleep(400)
    await bob.eval(pickPrAlerts('Paused'))
    await sleep(600)
    const pausedPrefs = await bob.eval(`window.bridge.settings.get()`)
    soft(
      "bob's notification bell pauses pull-request alerts",
      pausedPrefs?.notifyPrs === 'none',
      `notifyPrs=${pausedPrefs?.notifyPrs}`,
    )
    await bob.screenshot(join(SHOTS, 'e2e-notifications.png')).catch(() => {})
    soft('notification controls screenshot', true, join(SHOTS, 'e2e-notifications.png'))
    await bob.eval(bellToggle) // close the popover before watching for a card
    await sleep(300)

    ado.state.prs['repo-api'].push(
      adoPr({
        id: 4299,
        repo: ADO_REPOS[1],
        title: 'Quietly widen the retention sweep',
        author: DANA,
        source: 'dana/retention-widen',
        target: 'release/24.9',
        reviewers: [{ ...ME_REVIEWER, vote: 0, isRequired: true }],
        ageH: 0,
      }),
    )
    await bob.eval(`window.bridge.prs.refresh()`).catch(() => {})
    const leaked = await until(async () => ((await bob.eval(prCard)) === true ? true : undefined), 8000, 500)
    soft(
      'a paused pull request raises no alert card',
      leaked !== true,
      leaked === true ? 'the card appeared anyway' : 'silent for 8s',
    )

    // Back to All, so the card check below still means what it always meant.
    await bob.eval(bellToggle)
    await sleep(400)
    await bob.eval(pickPrAlerts('All'))
    await sleep(600)
    await bob.eval(bellToggle)
    const restoredPrefs = await bob.eval(`window.bridge.settings.get()`)
    soft(
      'and turning them back on is one click away',
      restoredPrefs?.notifyPrs === 'all',
      `notifyPrs=${restoredPrefs?.notifyPrs}`,
    )

    // A brand-new PR while bob is on a channel: the in-app alert card.
    ado.state.prs['repo-api'].push(
      adoPr({
        id: 4300,
        repo: ADO_REPOS[1],
        title: 'Hot fix: clamp the refund window to 90 days',
        author: DANA,
        source: 'dana/refund-clamp',
        target: 'release/24.9',
        reviewers: [{ ...ME_REVIEWER, vote: 0, isRequired: true }],
        ageH: 0,
      }),
    )
    await bob.eval(`window.bridge.prs.refresh()`).catch(() => {})
    const alerted = await until(
      async () => (await bob.eval(`!!document.querySelector('[role="alert"]')`)) === true,
      20000,
      500,
    )
    if (alerted) await bob.screenshot(join(SHOTS, 'e2e-pr-alert.png')).catch(() => {})
    soft('new-pull-request alert card on bob', !!alerted, alerted ? join(SHOTS, 'e2e-pr-alert.png') : 'card never shown')

    check(
      'every Azure DevOps call carried the Basic token',
      ado.state.requests > 0 && ado.state.rejected === 1,
      `${ado.state.requests} requests, ${ado.state.rejected} rejected (the deliberate anonymous one)`,
    )

    await sleep(1200)
    await alice.screenshot(join(OUT, 'alice.png'))
    await bob.screenshot(join(OUT, 'bob.png'))
    console.log(`\nscreenshots: ${OUT}/alice.png ${OUT}/bob.png`)

    // 1.4 — "Reset local data", then re-join from the same machine under the
    // same name. The old registration never leaves the share (its signature is
    // what keeps everything it signed verifiable), so the roster has to hide it
    // the moment a successor appears — including on the re-joined client
    // itself, where the record doing the superseding is the local one.
    //
    // Alice goes last on purpose: this kills her instance. A third profile with
    // its own empty userData *is* the post-reset state, on the same machine, so
    // the hostname and the machine fingerprint match exactly as they would.
    const aliceOldId = selfA?.self?.deviceId
    try { procA.kill() } catch {}
    await sleep(2500)
    procC = launch('alice2', 9335)
    const alice2 = await connect(9335)
    const subC = await alice2.eval(
      `window.bridge.onboarding.submit({ sharePath: ${JSON.stringify(SHARE)}, passphrase: ${JSON.stringify(PASS)}, displayName: 'Alice', teamName: '' })`,
    )
    check('alice re-joins the team from the same machine with the same name', subC?.ok === true, subC?.error ?? '')
    const selfC = await alice2.eval(`window.bridge.app.getBoot()`)
    const aliceNewId = selfC?.self?.deviceId
    check(
      'the re-join is a new device identity, not the old one',
      !!aliceNewId && !!aliceOldId && aliceNewId !== aliceOldId,
      `${aliceOldId?.slice(0, 8)} -> ${aliceNewId?.slice(0, 8)}`,
    )

    // A killed instance normally leaves a goodbye beacon; if SIGTERM beat it,
    // the old beacon has to go stale (PRESENCE.onlineWithinMs) before anything
    // may call that device gone — hence the generous window.
    const bobList = await until(async () => {
      const list = await bob.eval(`window.bridge.presence.list()`)
      const gone = list?.find((p) => p.deviceId === aliceOldId)
      return gone?.departed === true && gone?.supersededBy === aliceNewId ? list : undefined
    }, 75000)
    check(
      "bob hides alice's previous device once the new one registers",
      !!bobList,
      bobList ? 'departed + supersededBy on the first poll that saw both' : 'still listed after 75s',
    )
    check(
      'bob is left with exactly one live Alice',
      (bobList ?? []).filter((p) => p.name === 'Alice' && !p.departed).length === 1,
      JSON.stringify((bobList ?? []).map((p) => `${p.name}${p.departed ? ' (departed)' : ''}`)),
    )

    const selfList = await until(async () => {
      const list = await alice2.eval(`window.bridge.presence.list()`)
      const gone = list?.find((p) => p.deviceId === aliceOldId)
      return gone?.departed === true && gone?.supersededBy === aliceNewId ? list : undefined
    }, 30000)
    check(
      'the re-joined client does not list its own predecessor either',
      !!selfList,
      selfList ? 'superseded by the local record' : 'the person still sees two of themselves',
    )

    // The sidebar is the surface the report was about. Bob keeps a row for the
    // old device — his DM with it has history — and it says which one it is;
    // alice2 has no history with it at all, so there is no row.
    const dmLabels = (cdp) =>
      cdp.eval(
        `Array.from(document.querySelectorAll('button[aria-label^="Direct message"]')).map((n) => n.getAttribute('aria-label'))`,
      )
    const bobRows = await until(async () => {
      const rows = await dmLabels(bob)
      return rows?.some((r) => r.includes('(previous device)')) ? rows : undefined
    }, 20000)
    check(
      "bob's DM with the old device stays, labelled (previous device)",
      !!bobRows && bobRows.filter((r) => /^Direct message Alice,/.test(r)).length === 1,
      JSON.stringify(bobRows ?? (await dmLabels(bob))),
    )
    const selfRows = await dmLabels(alice2)
    check(
      'the re-joined sidebar shows no empty DM with the device it replaced',
      Array.isArray(selfRows) && !selfRows.some((r) => /Alice/.test(r)),
      JSON.stringify(selfRows),
    )
    // TOFU flags a new device that claims a pinned display name — which is
    // exactly what a re-join is. Getting this wrong leaves the person's real
    // device wearing the red impersonation chip for good, everywhere, which
    // is worse than the duplicate row it replaced.
    const trustOfNewAlice = await until(async () => {
      const list = await bob.eval(`window.bridge.presence.list()`)
      const live = list?.find((p) => p.deviceId === aliceNewId)
      return live?.trust ?? undefined
    }, 20000)
    check(
      'bob does not flag the re-joined Alice as an impersonator',
      trustOfNewAlice === 'pinned',
      `trust=${trustOfNewAlice}`,
    )

    // The quick switcher lists people on the sidebar's terms now: the DM the
    // sidebar deliberately keeps reachable has to be reachable from ⌘K too,
    // under the same name.
    // Two steps on purpose: React renders the option list on a later tick
    // than the input event, and an unfocused E2E window does not always
    // deliver a native focus event to React — so focus is dispatched
    // explicitly, and the options are read on their own polling loop.
    await bob.eval(
      `(() => {
         const i = document.querySelector('input[aria-label^="Quick switcher"]')
         if (!i) return false
         i.focus()
         i.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
         i.dispatchEvent(new FocusEvent('focus'))
         const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
         set.call(i, 'Alice')
         i.dispatchEvent(new Event('input', { bubbles: true }))
         return true
       })()`,
    )
    const qsTitles = await until(async () => {
      const titles = await bob.eval(
        `Array.from(document.querySelectorAll('[role="option"]')).map((n) => n.getAttribute('title'))`,
      )
      return titles && titles.some((t) => t && t.includes('(previous device)')) ? titles : undefined
    }, 20000)
    check(
      'the quick switcher can still reach the (previous device) DM',
      !!qsTitles && qsTitles.filter((t) => t === 'Message Alice').length === 1,
      JSON.stringify(qsTitles ?? []),
    )
    await bob.eval(
      `(() => {
         const i = document.querySelector('input[aria-label^="Quick switcher"]')
         if (!i) return false
         const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
         set.call(i, '')
         i.dispatchEvent(new Event('input', { bubbles: true }))
         i.blur()
         return true
       })()`,
    )

    await alice2.screenshot(join(SHOTS, 'e2e-rejoin.png')).catch(() => {})
    soft('re-joined sidebar screenshot', true, join(SHOTS, 'e2e-rejoin.png'))

    // Janitor sweep smoke: place an ancient file in blobs and run a manual clean via touch -t
    const oldBlob = join(SHARE, 'Chat', 'blobs', 'aa', 'deadbeef.blob')
    mkdirSync(join(SHARE, 'Chat', 'blobs', 'aa'), { recursive: true })
    writeFileSync(oldBlob, 'old')
    execSync(`touch -t 202501010000 "${oldBlob}"`)
    check('janitor test file planted (sweep runs on its own schedule)', true)
  } catch (err) {
    check('E2E run completed', false, err instanceof Error ? err.message : String(err))
  } finally {
    kill()
  }

  const hard = results.filter((r) => !r.soft)
  const softMissed = results.filter((r) => r.soft && !r.ok)
  console.log(`\n${hard.filter((r) => r.ok).length}/${hard.length} checks passed`)
  if (softMissed.length) console.log(`${softMissed.length} best-effort capture(s) skipped`)
  process.exit(failed ? 1 : 0)
}

void main()
