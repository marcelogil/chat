import { useEffect } from 'react'
import { useStore } from './store'
import Onboarding from './onboarding/Onboarding'
import UnlockScreen from './onboarding/UnlockScreen'
import AppShell from './app/AppShell'

// Router between boot states. Screens live in their own modules:
//   ./onboarding/Onboarding  — 4-step first-run flow
//   ./onboarding/UnlockScreen — passphrase-LMK unlock
//   ./app/AppShell           — the main three-pane application

export default function App() {
  const boot = useStore((s) => s.boot)
  const unlockNotice = useStore((s) => s.unlockNotice)
  const init = useStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  if (!boot) {
    return (
      <div className="flex h-full items-center justify-center" style={{ background: 'var(--bg-app)' }}>
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Starting…</div>
      </div>
    )
  }
  if (boot.mode === 'locked') return <UnlockScreen reason={boot.reason} notice={unlockNotice} />
  if (boot.mode === 'onboarding')
    return <Onboarding suggestion={boot.sharePathSuggestion} savedName={boot.savedName ?? null} />
  return <AppShell />
}
