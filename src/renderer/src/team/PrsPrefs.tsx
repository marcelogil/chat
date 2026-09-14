import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AdoError, PrsProbe, PrsRepo } from '@shared/types'
import { PRS } from '@shared/constants'
import { normalizeBaseUrl } from '@shared/prs'
import { useStore } from '@/store'
import { Button, Spinner } from '@/ui/atoms'
import { SectionLabel, Toggle } from '@/app/chrome'
import { IconCheck, IconWarn } from '@/app/icons'
import { toast } from '@/app/toasts'
import { errorSentence } from './PrsPane'

// Spec §2.7 — the pull-request prefs modal (SettingsModal scrim/dialog
// pattern, 640px). Three steps in one scroll: connect → repositories →
// sharing. The token typed here is used for the probe, handed to
// `prs.saveConfig`, and then dropped from state: it is never re-rendered.

interface RepoRow {
  id: string
  name: string
  defaultBranch: string
  /** A saved repo the live list no longer returns — rendered greyed, with no
   * fresh default-branch data, and only meaningfully unchecked (to drop it). */
  stale?: boolean
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SectionLabel>{label}</SectionLabel>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: '16px' }}>{hint}</div>}
    </div>
  )
}

/** A typed threshold, or null while it is empty or outside the shared range. */
function whole(text: string, [lo, hi]: readonly [number, number]): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null
  const n = Number.parseInt(text.trim(), 10)
  return n >= lo && n <= hi ? n : null
}

function Note({ tone, children }: { tone: 'info' | 'warn'; children: ReactNode }) {
  const color = tone === 'warn' ? 'var(--warning)' : 'var(--text-3)'
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 'var(--r-md)',
        background: tone === 'warn' ? 'color-mix(in srgb, var(--warning) 10%, transparent)' : 'var(--bg-raised)',
        fontSize: 12,
        lineHeight: '17px',
        color: 'var(--text-2)',
      }}
    >
      <span style={{ color, flexShrink: 0, marginTop: 1 }}>
        <IconWarn size={13} />
      </span>
      <span>{children}</span>
    </div>
  )
}

export function PrsPrefs({ onClose }: { onClose: () => void }) {
  const status = useStore((s) => s.prsStatus)
  const configured = status?.configured === true

  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? '')
  const [token, setToken] = useState('')
  const [probing, setProbing] = useState(false)
  // Distinguishes the silent on-open probe from a user-initiated "Test
  // connection" click, so only the former shows "Checking the saved
  // connection…" — the button already carries its own spinner for the latter.
  const [autoProbing, setAutoProbing] = useState(false)
  // StrictMode double-invokes a mount effect (same render's closure, so
  // `probing` reads back stale/false both times) — a plain ref latch mutates
  // in place and is shared across both invocations, unlike state.
  const autoProbedRef = useRef(false)
  const [probe, setProbe] = useState<PrsProbe | null>(null)
  const [project, setProject] = useState(status?.project ?? '')
  const [repos, setRepos] = useState<RepoRow[]>([])
  const [repoError, setRepoError] = useState<AdoError | null>(null)
  const [loadingRepos, setLoadingRepos] = useState(false)
  // Snapshot of the previously-saved repos, taken once when the pane opened.
  // A saved repo the live list no longer returns still needs to render (as a
  // greyed "not found on server" row the team can uncheck to actually drop
  // it) instead of just silently vanishing the moment the fresh list lands.
  const [savedRepos] = useState<PrsRepo[]>(() => status?.repos ?? [])
  // The project those saved repos belong to — a stale row only makes sense
  // while still looking at that same project; switching to a different one
  // (this org has more than one) must not paint its repos as "not found".
  const [savedProject] = useState(() => status?.project ?? '')
  const [checked, setChecked] = useState<Record<string, true>>(() => {
    const init: Record<string, true> = {}
    for (const r of savedRepos) init[r.id] = true
    return init
  })
  const [repoQuery, setRepoQuery] = useState('')
  // Off by default for a new connection; prefilled from the team config when
  // editing, so re-saving the repo list never silently un-shares a token the
  // rest of the team is relying on.
  const [share, setShare] = useState(status?.sharedTokenSet === true)
  // 1.4 — the two team-shared waiting thresholds. Kept as text so the field
  // can be empty mid-edit; Save is blocked until both parse inside the range
  // that `prs.saveConfig` enforces on the other side of the bridge.
  const [slaHours, setSlaHours] = useState(() => String(status?.reviewSlaHours ?? PRS.reviewSlaHours))
  const [staleDays, setStaleDays] = useState(() => String(status?.staleAfterDays ?? PRS.staleAfterDays))
  const [saving, setSaving] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  // The probe result belongs to the exact URL+token it was made with; editing
  // either invalidates it (and with it the Save button).
  const [probedKey, setProbedKey] = useState('')
  const trimmedToken = token.trim()
  const normalized = useMemo(() => normalizeBaseUrl(baseUrl), [baseUrl])
  const probeValid = probe?.ok === true && probedKey !== '' && probedKey ===`${normalized ?? ''} ${trimmedToken}`

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Repositories for the chosen project. Reloaded whenever the project changes;
  // the checked set is pruned to what actually exists there.
  useEffect(() => {
    if (!probeValid || project === '' || normalized === null) {
      setRepos([])
      return undefined
    }
    let cancelled = false
    // Drop the previous project's rows before the round trip: they must never
    // be savable against the new project (their ids do not exist there).
    setRepos([])
    setRepoQuery('')
    setLoadingRepos(true)
    setRepoError(null)
    void window.bridge.prs
      .listRepos({ baseUrl: normalized, token: trimmedToken, project })
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          setRepos(res.value)
          const live = new Set(res.value.map((r) => r.id))
          // A saved repo id is kept even when this project's live list didn't
          // return it — it renders as a "not found on server" row (below)
          // instead of quietly disappearing; only a checked id that is
          // neither live nor part of the saved config for *this* project
          // (leftover from checking a different project earlier in this
          // session) is pruned.
          const saved = new Set(project === savedProject ? savedRepos.map((r) => r.id) : [])
          setChecked((prev) => {
            const next: Record<string, true> = {}
            for (const id of Object.keys(prev)) if (live.has(id) || saved.has(id)) next[id] = true
            return next
          })
        } else {
          setRepos([])
          setRepoError(res.error)
        }
      })
      .catch(() => {
        if (!cancelled) setRepoError({ code: 'network', detail: '' })
      })
      .finally(() => {
        if (!cancelled) setLoadingRepos(false)
      })
    return () => {
      cancelled = true
    }
  }, [probeValid, project, normalized, trimmedToken])

  async function test(opts?: { auto?: boolean }) {
    if (probing) return
    if (normalized === null) {
      setProbe({ ok: false, error: { code: 'bad-url', detail: '' } })
      setProbedKey('')
      return
    }
    setProbing(true)
    if (opts?.auto) setAutoProbing(true)
    try {
      const res = await window.bridge.prs.testConnection({ baseUrl: normalized, token: trimmedToken })
      setProbe(res)
      setProbedKey(res.ok ?`${normalized} ${trimmedToken}` : '')
    } catch {
      setProbe({ ok: false, error: { code: 'network', detail: '' } })
      setProbedKey('')
    } finally {
      setProbing(false)
      setAutoProbing(false)
    }
  }

  // Auto-probe on open (plan §D1 / ask #2): a saved config with the token
  // field still blank means this device may already carry a personal token
  // for that origin — prService's probeToken() already falls back to it (or
  // to the shared token) — so try silently before making someone re-paste a
  // token the app already has. Mount-only: re-arming this on every keystroke
  // would fight the manual "Test connection" button. A device with no stored
  // token for this origin just gets the ordinary failed-probe error below,
  // and the form is otherwise exactly as usable as it always was.
  useEffect(() => {
    if (autoProbedRef.current) return
    if (configured && trimmedToken === '') {
      autoProbedRef.current = true
      void test({ auto: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const projects = probe?.ok ? probe.projects : []

  // Once a probe lands, settle on a project: keep the configured one when the
  // server still has it, otherwise take the only one there is.
  useEffect(() => {
    if (!probeValid || projects.length === 0) return
    const has = (name: string) => projects.some((p) => p.name === name || p.id === name)
    if (project !== '' && has(project)) return
    setProject(projects.length === 1 ? projects[0].name : '')
  }, [probeValid, projects, project])

  // Saved repos the live list didn't return this round — shown as their own
  // greyed rows (plan §D1) rather than just disappearing the moment the
  // fresh list lands, so unchecking one is how the team actually drops it.
  const staleRepos = useMemo<RepoRow[]>(() => {
    if (project !== savedProject) return []
    const live = new Set(repos.map((r) => r.id))
    return savedRepos.filter((r) => !live.has(r.id)).map((r) => ({ id: r.id, name: r.name, defaultBranch: '', stale: true }))
  }, [repos, savedRepos, project, savedProject])

  const allRepos = useMemo<RepoRow[]>(() => [...repos, ...staleRepos], [repos, staleRepos])

  const visibleRepos = useMemo(() => {
    const q = repoQuery.trim().toLowerCase()
    const list = q === '' ? allRepos : allRepos.filter((r) => r.name.toLowerCase().includes(q))
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  }, [allRepos, repoQuery])

  const checkedRepos = useMemo(() => allRepos.filter((r) => checked[r.id]).map((r) => ({ id: r.id, name: r.name })), [allRepos, checked])
  const sla = whole(slaHours, PRS.reviewSlaHoursRange)
  const stale = whole(staleDays, PRS.staleAfterDaysRange)
  const canSave =
    probeValid &&
    checkedRepos.length > 0 &&
    !saving &&
    !loadingRepos &&
    normalized !== null &&
    project !== '' &&
    sla !== null &&
    stale !== null

  async function save() {
    if (!canSave || normalized === null || sla === null || stale === null) return
    setSaving(true)
    try {
      await window.bridge.prs.saveConfig({
        baseUrl: normalized,
        project,
        repos: checkedRepos,
        token: trimmedToken,
        shareToken: share,
        reviewSlaHours: sla,
        staleAfterDays: stale,
      })
      setToken('') // the secret leaves the DOM the moment it is stored
      setProbedKey('')
      void window.bridge.prs.refresh().catch(() => {})
      toast('Pull requests connected', 'success')
      onClose()
    } catch {
      toast('Could not save the pull-request settings', 'danger')
      setSaving(false)
    }
  }

  async function disconnect() {
    setSaving(true)
    try {
      await window.bridge.prs.disconnect()
      setToken('')
      toast('Pull requests disconnected', 'info')
      onClose()
    } catch {
      toast('Could not disconnect', 'danger')
      setSaving(false)
    }
  }

  const tokenPageUrl = normalized ? `${normalized}/_usersSettings/tokens` : ''

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'sem-fade var(--t-fast) var(--ease-standard)',
      }}
    >
      <div
        role="dialog"
        aria-label="Azure DevOps pull requests"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 640,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 48px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--elev-3)',
          overflow: 'hidden',
          animation: 'sem-pop var(--t-base) var(--ease-pop)',
        }}
      >
        <div
          style={{
            padding: '16px 20px 12px',
            borderBottom: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>Pull requests · Azure DevOps</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: '17px' }}>
            The collection, project and repositories are shared with the whole team. Tokens are personal unless you
            deliberately share one below.
          </div>
        </div>

        <div className="sem-scroll" style={{ flex: 1, minHeight: 0, padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* 1 — Connect */}
          <Field
            label="Collection or organization URL"
            hint="Azure DevOps Services: https://dev.azure.com/your-org · on-prem Server: https://tfs.corp/tfs/DefaultCollection"
          >
            <input
              className="sem-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://dev.azure.com/your-org"
              aria-label="Azure DevOps collection or organization URL"
              title="Azure DevOps collection or organization URL"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          <Field
            label="Personal access token"
            hint={
              configured && trimmedToken === ''
                ? 'Leave blank to keep the token this machine already uses — testing the connection will use it too.'
                : 'Scope Code → Read is enough. A short expiry is a good idea.'
            }
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="sem-input"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste a token"
                aria-label="Azure DevOps personal access token"
                title="Azure DevOps personal access token"
                spellCheck={false}
                autoComplete="off"
                style={{ flex: 1 }}
              />
              <Button
                variant="ghost"
                disabled={probing || (trimmedToken === '' && !configured) || baseUrl.trim() === ''}
                onClick={() => void test()}
              >
                {probing ? <Spinner size={13} /> : 'Test connection'}
              </Button>
            </div>
            {tokenPageUrl !== '' && (
              <button
                className="sem-focus"
                onClick={() => void window.bridge.app.openExternal(tokenPageUrl).catch(() => {})}
                title={tokenPageUrl}
                aria-label="Open the Azure DevOps token page"
                style={{
                  alignSelf: 'flex-start',
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  color: 'var(--accent-text)',
                  fontSize: 12,
                  fontFamily: 'var(--font-ui)',
                  cursor: 'pointer',
                }}
              >
                Create one at {tokenPageUrl} →
              </button>
            )}
          </Field>

          {autoProbing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)', fontSize: 13 }}>
              <Spinner size={14} /> Checking the saved connection…
            </div>
          )}

          <Note tone="info">
            SSH keys only authenticate Git — the REST API this pane uses needs a token. Nothing else works, no matter
            how the repository is cloned.
          </Note>

          {probe && !probe.ok && (
            <div
              role="alert"
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                padding: '8px 10px',
                borderRadius: 'var(--r-md)',
                background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
                color: 'var(--text-1)',
                fontSize: 13,
              }}
            >
              <span style={{ color: 'var(--danger)', display: 'flex', marginTop: 1 }}>
                <IconWarn size={15} />
              </span>
              <div style={{ minWidth: 0 }}>
                {errorSentence(probe.error)}
                {/* The redacted main-side detail (status line, first bytes of
                    the body) — the only thing that distinguishes a proxy block
                    page from a throttled org from a typo. Selectable so it can
                    be pasted into a bug report. */}
                {probe.error.detail && (
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 12,
                      color: 'var(--text-3)',
                      fontFamily: 'var(--font-mono)',
                      wordBreak: 'break-word',
                      userSelect: 'text',
                    }}
                  >
                    {probe.error.detail}
                  </div>
                )}
              </div>
            </div>
          )}

          {probe?.ok && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-1)' }}>
                <span style={{ color: 'var(--success)', display: 'flex' }}>
                  <IconCheck size={15} />
                </span>
                Signed in as {probe.me.name}
                {/* Which REST API version this server settled on — 6.0 on
                    dev.azure.com and Server 2020+, lower on an older on-prem
                    box. Worth showing: it is the one number that explains an
                    otherwise identical-looking failure later. */}
                <span style={{ color: 'var(--text-3)', fontSize: 12 }}>· API {probe.apiVersion}</span>
                {!probeValid && (
                  <span style={{ color: 'var(--text-3)', fontSize: 12 }}>— test again after editing the URL or token</span>
                )}
              </div>

              <Field label="Project" hint="Only one project per team folder — pick the one the repositories live in.">
                <select
                  className="sem-input sem-focus"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  aria-label="Azure DevOps project"
                  title="Azure DevOps project"
                  style={{ cursor: 'pointer' }}
                >
                  <option value="">Choose a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}

          {/* 2 — Repositories */}
          {probeValid && project !== '' && (
            <Field label={`Repositories to watch (${checkedRepos.length} selected)`}>
              {loadingRepos ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)', fontSize: 13 }}>
                  <Spinner size={14} /> Loading repositories…
                </div>
              ) : repoError ? (
                <div style={{ fontSize: 13, color: 'var(--danger)' }}>
                  {errorSentence(repoError)}
                  {repoError.detail && (
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 12,
                        color: 'var(--text-3)',
                        fontFamily: 'var(--font-mono)',
                        wordBreak: 'break-word',
                        userSelect: 'text',
                      }}
                    >
                      {repoError.detail}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      className="sem-input"
                      value={repoQuery}
                      onChange={(e) => setRepoQuery(e.target.value)}
                      placeholder="Filter repositories"
                      aria-label="Filter repositories"
                      title="Filter repositories"
                      style={{ flex: 1, height: 28 }}
                    />
                    <button
                      className="sem-chip-btn sem-focus"
                      title="Select every repository shown"
                      aria-label="Select all repositories"
                      onClick={() =>
                        setChecked((prev) => {
                          const next = { ...prev }
                          for (const r of visibleRepos) next[r.id] = true
                          return next
                        })
                      }
                      style={{ height: 28 }}
                    >
                      All
                    </button>
                    <button
                      className="sem-chip-btn sem-focus"
                      title="Clear the selection"
                      aria-label="Select no repositories"
                      onClick={() =>
                        setChecked((prev) => {
                          const next = { ...prev }
                          for (const r of visibleRepos) delete next[r.id]
                          return next
                        })
                      }
                      style={{ height: 28 }}
                    >
                      None
                    </button>
                  </div>
                  <div
                    className="sem-scroll"
                    style={{
                      maxHeight: 180,
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--r-md)',
                      padding: 4,
                    }}
                  >
                    {visibleRepos.length === 0 ? (
                      <div style={{ padding: 10, fontSize: 12, color: 'var(--text-3)' }}>
                        {allRepos.length === 0 ? 'This project has no repositories.' : 'No repository matches that filter.'}
                      </div>
                    ) : (
                      visibleRepos.map((r) => (
                        <label
                          key={r.id}
                          className="sem-row"
                          title={
                            r.stale
                              ? `${r.name} · not found on server — uncheck to stop watching it`
                              : `${r.name} · default branch ${r.defaultBranch.replace('refs/heads/', '') || 'unknown'}`
                          }
                          style={{ height: 28, gap: 8, padding: '0 8px', borderRadius: 'var(--r-sm)', opacity: r.stale ? 0.55 : 1 }}
                        >
                          <input
                            type="checkbox"
                            checked={checked[r.id] === true}
                            aria-label={r.stale ? `${r.name} — not found on server, uncheck to stop watching it` : `Watch ${r.name}`}
                            onChange={(e) =>
                              setChecked((prev) => {
                                const next = { ...prev }
                                if (e.target.checked) next[r.id] = true
                                else delete next[r.id]
                                return next
                              })
                            }
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-1)' }}>{r.name}</span>
                          {r.stale ? (
                            <span style={{ fontSize: 11, color: 'var(--warning)', fontStyle: 'italic' }}>not found on server</span>
                          ) : (
                            <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                              {r.defaultBranch.replace('refs/heads/', '')}
                            </span>
                          )}
                        </label>
                      ))
                    )}
                  </div>
                </>
              )}
            </Field>
          )}

          {/* 3 — Sharing */}
          <Field label="Sharing">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, color: 'var(--text-1)' }}>
                  Share this token with the team
                </span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
                  {share
                    ? 'Everyone in the team folder can read it.'
                    : 'Teammates will enter their own token.'}
                </span>
              </span>
              <Toggle on={share} onChange={setShare} label="Share this token with the team" />
            </div>
            {share && (
              <Note tone="warn">
                The token is written into the shared folder, encrypted under the team passphrase. That means anyone who
                can open this team — now or later, on any machine — can read it and act as you in Azure DevOps. Only
                share a read-only token (scope <b>Code → Read</b>) with a short expiry.
              </Note>
            )}
          </Field>

          {/* 4 — Waiting thresholds (1.4), shared with the whole team */}
          <Field
            label="Waiting thresholds"
            hint={`Shared with the team, like the repository list. ${PRS.reviewSlaHoursRange[0]}–${PRS.reviewSlaHoursRange[1]} hours and ${PRS.staleAfterDaysRange[0]}–${PRS.staleAfterDaysRange[1]} days.`}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-1)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>Flag a review as overdue after</span>
              <input
                className="sem-input"
                type="number"
                inputMode="numeric"
                min={PRS.reviewSlaHoursRange[0]}
                max={PRS.reviewSlaHoursRange[1]}
                value={slaHours}
                onChange={(e) => setSlaHours(e.target.value)}
                aria-label="Flag a review as overdue after this many hours"
                title="Flag a review as overdue after this many hours"
                style={{ width: 82, textAlign: 'right', borderColor: sla === null ? 'var(--danger)' : undefined }}
              />
              <span style={{ color: 'var(--text-3)', width: 46 }}>hours</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-1)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>Call a pull request stale after</span>
              <input
                className="sem-input"
                type="number"
                inputMode="numeric"
                min={PRS.staleAfterDaysRange[0]}
                max={PRS.staleAfterDaysRange[1]}
                value={staleDays}
                onChange={(e) => setStaleDays(e.target.value)}
                aria-label="Call a pull request stale after this many days with no activity"
                title="Call a pull request stale after this many days with no activity"
                style={{ width: 82, textAlign: 'right', borderColor: stale === null ? 'var(--danger)' : undefined }}
              />
              <span style={{ color: 'var(--text-3)', width: 46 }}>days</span>
            </label>
          </Field>
        </div>

        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 20px',
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          {configured &&
            (confirmDisconnect ? (
              <>
                <span style={{ fontSize: 12, color: 'var(--warning)' }}>Stop watching for the whole team?</span>
                <Button variant="danger" disabled={saving} onClick={() => void disconnect()}>
                  Yes, disconnect
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>
                  Keep it
                </Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => setConfirmDisconnect(true)}>
                Disconnect
              </Button>
            ))}
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => void save()}
            style={{ minWidth: 72, display: 'inline-flex', justifyContent: 'center' }}
          >
            {saving ? <Spinner size={13} /> : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
