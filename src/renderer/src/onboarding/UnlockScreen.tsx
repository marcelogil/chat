import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Spinner } from '@/ui/atoms'
import { ChromeCss } from '@/app/chrome'
import { IconLock, IconWarn } from '@/app/icons'
import { GradientMesh } from './mesh'
import { DangerText } from './steps'

// Passphrase-sealed machines unlock each launch (spec §2.5 sibling). One
// field; a wrong passphrase shakes and explains, nothing else moves.
//
// The reset card is the one honest exit when the local seal can't be opened
// any more — by any build (an OS-keystore entry from before 1.0.2, a DPAPI
// profile moved between user accounts, a corrupt seal), or by this user (the
// passphrase is forgotten, or the team folder was re-created with a new one).

export default function UnlockScreen({
  reason,
  notice,
}: {
  reason: 'passphrase' | 'unrecoverable'
  /**
   * Why the user is looking at this screen instead of where they were —
   * onboarding refusing to set up over this machine's existing, locked data
   * (see the store's `unlockNotice`). Null on an ordinary launch.
   */
  notice?: string | null
}) {
  const [forgot, setForgot] = useState(false)
  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-app)',
        overflow: 'hidden',
      }}
    >
      <ChromeCss />
      <GradientMesh />
      {reason === 'unrecoverable' ? (
        <ResetCard cause="unrecoverable" notice={notice} />
      ) : forgot ? (
        <ResetCard cause="forgotten" onBack={() => setForgot(false)} />
      ) : (
        <PassphraseCard onForgot={() => setForgot(true)} notice={notice} />
      )}
    </div>
  )
}

const cardStyle = {
  position: 'relative',
  width: 380,
  maxWidth: 'calc(100vw - 48px)',
  background: 'var(--bg-panel)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-3)',
  padding: 28,
  textAlign: 'center',
} as const

function CardIcon({ children, tone }: { children: ReactNode; tone: 'accent' | 'warn' }) {
  return (
    <div
      style={{
        width: 44,
        height: 44,
        margin: '0 auto 14px',
        borderRadius: 'var(--r-md)',
        background: tone === 'accent' ? 'var(--accent-soft)' : 'color-mix(in srgb, var(--warning) 16%, transparent)',
        color: tone === 'accent' ? 'var(--accent-text)' : 'var(--warning)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </div>
  )
}

const linkStyle = {
  background: 'none',
  border: 0,
  padding: 0,
  font: 'inherit',
  fontSize: 12,
  color: 'var(--text-3)',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
  cursor: 'pointer',
} as const

/**
 * The "why are you here" strip above a card's own copy. Warning-toned, quiet,
 * and never a dead end: whatever sent the user here says what to do next.
 */
function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        marginTop: 12,
        marginBottom: 4,
        padding: '10px 12px',
        textAlign: 'left',
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--text-2)',
        background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--warning) 36%, transparent)',
        borderRadius: 'var(--r-md)',
      }}
    >
      {children}
    </div>
  )
}

function PassphraseCard({ onForgot, notice }: { onForgot: () => void; notice?: string | null }) {
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [fails, setFails] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Runs on mount and after each failed attempt (the card is re-keyed).
    inputRef.current?.focus()
  }, [fails])

  async function unlock() {
    if (!pass || busy) return
    setBusy(true)
    const ok = await window.bridge.app.unlock(pass).catch(() => false)
    setBusy(false)
    if (!ok) {
      setFails((f) => f + 1)
      setPass('')
    }
    // On success the boot push swaps App to the shell.
  }

  return (
    <div
      key={fails}
      style={{
        ...cardStyle,
        animation: fails > 0 ? 'sem-shake 300ms var(--ease-standard)' : 'sem-rise var(--t-base) var(--ease-standard)',
      }}
    >
      <CardIcon tone="accent">
        <IconLock size={20} />
      </CardIcon>
      <div style={{ fontSize: 22, fontWeight: 600, lineHeight: '28px', color: 'var(--text-1)' }}>Welcome back</div>
      <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 6, marginBottom: notice ? 0 : 18 }}>
        Your messages are encrypted on this computer. Enter the team passphrase to unlock them.
      </div>
      {notice && <Notice>{notice}</Notice>}
      {notice && <div style={{ height: 14 }} />}

      <input
        ref={inputRef}
        className="sem-input"
        type="password"
        style={{ height: 36, textAlign: 'center', borderColor: fails > 0 ? 'var(--danger)' : undefined }}
        placeholder="Team passphrase"
        aria-label="Team passphrase"
        aria-invalid={fails > 0}
        value={pass}
        disabled={busy}
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void unlock()
        }}
      />
      {fails > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <DangerText>Wrong passphrase — try again.</DangerText>
        </div>
      )}

      <Button onClick={() => void unlock()} disabled={!pass || busy} style={{ width: '100%', marginTop: 14, height: 34 }}>
        {busy ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Spinner size={13} /> Unlocking…
          </span>
        ) : (
          'Unlock'
        )}
      </Button>
      {/* With a notice up there the reset path is part of what the user was
          just told to choose from, so it can't wait for a failed attempt. */}
      {(fails > 0 || !!notice) && (
        <div style={{ marginTop: 14 }}>
          <button type="button" style={linkStyle} onClick={onForgot} disabled={busy}>
            {notice ? 'Reset local data — start over as a new device' : 'Forgot it, or the team folder has a new passphrase?'}
          </button>
        </div>
      )}
    </div>
  )
}

function ResetCard({
  cause,
  onBack,
  notice,
}: {
  cause: 'unrecoverable' | 'forgotten'
  onBack?: () => void
  notice?: string | null
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reset() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await window.bridge.app.resetLocalData()
      // On success the boot push swaps App to onboarding.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div style={{ ...cardStyle, animation: 'sem-rise var(--t-base) var(--ease-standard)' }}>
      <CardIcon tone="warn">
        <IconWarn size={20} />
      </CardIcon>
      <div style={{ fontSize: 22, fontWeight: 600, lineHeight: '28px', color: 'var(--text-1)' }}>
        Start fresh on this computer
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 6, marginBottom: 18, lineHeight: '19px' }}>
        {cause === 'unrecoverable'
          ? 'Chat can’t open the data it saved on this computer — it was sealed by a different version or user account. '
          : 'Without the passphrase it was sealed with, the data saved on this computer can’t be opened. '}
        Starting fresh clears it and takes you through setup again. Channel history stays in the team
        folder and reloads. This computer will appear to teammates as a new device, and direct messages
        sent to the old one can’t be read any more.
      </div>
      {notice && (
        <div style={{ marginTop: -6, marginBottom: 14 }}>
          <Notice>{notice}</Notice>
        </div>
      )}
      <Button onClick={() => void reset()} disabled={busy} style={{ width: '100%', height: 34 }}>
        {busy ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Spinner size={13} /> Clearing…
          </span>
        ) : (
          'Start fresh'
        )}
      </Button>
      {error && (
        <div style={{ display: 'flex', justifyContent: 'center', textAlign: 'left' }}>
          <DangerText>Couldn’t clear the local data: {error}</DangerText>
        </div>
      )}
      {onBack && (
        <div style={{ marginTop: 14 }}>
          <button type="button" style={linkStyle} onClick={onBack} disabled={busy}>
            Back to unlock
          </button>
        </div>
      )}
    </div>
  )
}
