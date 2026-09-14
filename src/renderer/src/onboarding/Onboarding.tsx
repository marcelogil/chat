import { useEffect, useMemo, useState } from 'react'
import type { OnboardHealth } from '@shared/bridge'
import { useStore } from '@/store'
import { Button, Spinner } from '@/ui/atoms'
import { ChromeCss } from '@/app/chrome'
import { GradientMesh } from './mesh'
import { StepFolder, StepPassphrase, StepIdentity, StepDevice } from './steps'

// Spec §2.5 — the signature first-run flow. One 520px card, four steps with
// slide transitions and progress dots; ends by submitting the whole config
// (the resulting boot push swaps App to the shell).

const STEP_COUNT = 4

export default function Onboarding({
  suggestion,
  savedName,
}: {
  suggestion: string | null
  savedName?: string | null
}) {
  const [step, setStep] = useState(0)
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')

  const [sharePath, setSharePath] = useState<string | null>(null)
  const [health, setHealth] = useState<OnboardHealth | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  const [passphrase, setPassphrase] = useState('')
  const [teamName, setTeamName] = useState('')
  const [displayName, setDisplayName] = useState(savedName ?? '')
  const [hostname, setHostname] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [errStep, setErrStep] = useState<number | null>(null)
  const [shakeKey, setShakeKey] = useState(0)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    void window.bridge.onboarding
      .detectDevice()
      .then((d) => setHostname(d.hostname))
      .catch(() => setHostname(''))
  }, [])

  const joining = !!health?.existingTeamName

  function go(next: number) {
    setDir(next > step ? 'fwd' : 'back')
    setStep(next)
  }

  async function choose(path: string) {
    setSharePath(path)
    setHealth(null)
    setCheckError(null)
    setChecking(true)
    try {
      setHealth(await window.bridge.onboarding.healthCheck(path))
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  async function pick() {
    try {
      const path = await window.bridge.onboarding.pickFolder()
      if (path) await choose(path)
    } catch {
      setCheckError('Could not open the folder picker')
    }
  }

  async function submit() {
    if (!sharePath || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    setErrStep(null)
    const res = await window.bridge.onboarding
      .submit({
        sharePath,
        passphrase,
        displayName: displayName.trim(),
        teamName: joining ? (health?.existingTeamName ?? '') : teamName.trim(),
      })
      .catch((err) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
        message: undefined as string | undefined,
      }))
    if (res.ok) {
      setLeaving(true) // the boot push replaces this screen; scale out gracefully
      return
    }
    // This machine already holds sealed Chat data nobody has unlocked. Setting
    // up here would destroy the device identity in it, so main refused — the
    // only honest next screen is the unlock one, which also carries the
    // confirmed "start fresh" path for someone who really does want a new
    // device. The notice lives in the store, so it survives this unmount.
    if (res.error === 'locked-profile') {
      void useStore.getState().showUnlockScreen(res.message ?? res.error)
      return
    }
    setSubmitting(false)
    setSubmitError(res.message ?? res.error)
    if (/passphrase|decrypt|wrong|check/i.test(res.error)) {
      setErrStep(1)
      setShakeKey((k) => k + 1)
      go(1)
    } else {
      setErrStep(3)
    }
  }

  const canContinue = useMemo(() => {
    switch (step) {
      case 0:
        return !!health && health.writable && health.readBack && !checking
      case 1:
        return passphrase.length > 0 && (joining || teamName.trim().length > 0)
      case 2:
        return displayName.trim().length > 0
      default:
        return true
    }
  }, [step, health, checking, passphrase, joining, teamName, displayName])

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

      <div
        style={{
          position: 'relative',
          width: 520,
          maxWidth: 'calc(100vw - 48px)',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--elev-3)',
          padding: 32,
          overflow: 'hidden',
          transform: leaving ? 'scale(0.94)' : 'scale(1)',
          opacity: leaving ? 0 : 1,
          transition: 'transform 400ms var(--ease-glide), opacity 400ms var(--ease-glide)',
        }}
      >
        <div
          aria-label={`Step ${step + 1} of ${STEP_COUNT}`}
          style={{ position: 'absolute', top: 20, right: 20, display: 'flex', gap: 6 }}
        >
          {Array.from({ length: STEP_COUNT }, (_, i) => (
            <span
              key={i}
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: i === step ? 'var(--accent)' : i < step ? 'var(--accent-text)' : 'var(--bg-raised)',
                opacity: i < step ? 0.6 : 1,
                transition: 'background var(--t-fast) var(--ease-standard)',
              }}
            />
          ))}
        </div>

        <div
          key={step}
          style={{
            animation: `${dir === 'fwd' ? 'sem-step-in-r' : 'sem-step-in-l'} 240ms var(--ease-standard)`,
          }}
        >
          {step === 0 && (
            <StepFolder
              suggestion={suggestion}
              sharePath={sharePath}
              health={health}
              checking={checking}
              error={checkError}
              onChoose={(p) => void choose(p)}
              onPick={() => void pick()}
            />
          )}
          {step === 1 && (
            <StepPassphrase
              joining={joining}
              existingTeamName={health?.existingTeamName ?? null}
              passphrase={passphrase}
              onPassphrase={(v) => {
                setPassphrase(v)
                if (errStep === 1) {
                  setSubmitError(null)
                  setErrStep(null)
                }
              }}
              teamName={teamName}
              onTeamName={setTeamName}
              error={errStep === 1 ? submitError : null}
              shakeKey={shakeKey}
            />
          )}
          {step === 2 && (
            <StepIdentity displayName={displayName} onDisplayName={setDisplayName} hostname={hostname} />
          )}
          {step === 3 && <StepDevice hostname={hostname} error={errStep === 3 ? submitError : null} />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 28 }}>
          {step > 0 ? (
            <Button variant="ghost" onClick={() => go(step - 1)} disabled={submitting}>
              Back
            </Button>
          ) : (
            <span />
          )}
          {step < 3 ? (
            <Button onClick={() => go(step + 1)} disabled={!canContinue}>
              Continue
            </Button>
          ) : (
            <Button onClick={() => void submit()} disabled={submitting || leaving} style={{ minWidth: 220 }}>
              {submitting || leaving ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Spinner size={13} /> Entering the team…
                </span>
              ) : (
                'Looks good — enter the team'
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
