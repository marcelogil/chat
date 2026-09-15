import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConvId } from '@shared/types'
import { convNameMax, planRename, type RenameKind } from './renamePlan'
import { toast } from './toasts'

// The inline rename the sidebar rows have always had (1.2), lifted into its own
// component so the conversation header and the right rail's About tab can start
// the *same* edit (1.5): same normalization, same Enter/Escape/blur behaviour,
// same refusal for the team's home channel — see renamePlan.ts.

export function ConvRenameInput({
  conv,
  kind,
  current,
  fixed,
  style,
  onDone,
}: {
  conv: ConvId
  kind: RenameKind
  current: string
  /** Channels only: the home channel, which can never be renamed. */
  fixed?: boolean
  style?: CSSProperties
  onDone: () => void
}) {
  const [value, setValue] = useState(current)
  const ref = useRef<HTMLInputElement>(null)
  // A second submit must not fire: blur-to-submit runs again when the input
  // unmounts behind a dialog, and Enter blurs the field on its way out.
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  async function submit() {
    if (done.current) return
    done.current = true
    const plan = planRename({ kind, current, input: value, fixed })
    onDone()
    if (plan.action === 'refuse') {
      toast(plan.reason, 'info')
      return
    }
    if (plan.action !== 'rename') return
    try {
      if (kind === 'channel') await window.bridge.chat.renameChannel(conv, plan.name)
      else await window.bridge.groups.rename(conv, plan.name)
    } catch (err) {
      toast(
        `Could not rename ${kind === 'channel' ? `#${current}` : current} — ${err instanceof Error ? err.message : String(err)}`,
        'danger',
      )
    }
  }

  return (
    <input
      ref={ref}
      className="sem-input"
      value={value}
      maxLength={convNameMax(kind)}
      aria-label={`Rename ${kind === 'channel' ? `#${current}` : current}`}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void submit()
        if (e.key === 'Escape') {
          done.current = true
          onDone()
        }
      }}
      onBlur={() => void submit()}
      spellCheck={false}
      style={style}
    />
  )
}
