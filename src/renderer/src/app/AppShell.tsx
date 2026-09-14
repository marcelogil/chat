import { useEffect, useMemo, useState } from 'react'
import { TEAM_CONV } from '@shared/constants'
import { isDmConv, isGrpConv, isTeamConv } from '@shared/ids'
import { useStore } from '@/store'
import ChatPane from '@/chat/ChatPane'
import { CalendarPane } from '@/team/CalendarPane'
import { PrsPane } from '@/team/PrsPane'
import { PrAlert } from '@/team/PrAlert'
import { Lightbox } from '@/content/Lightbox'
import { DiagramRoot } from '@/diagram/DiagramRoot'
import { ChromeCss, DRAG, NO_DRAG, isMac } from './chrome'
import Sidebar from './Sidebar'
import ChannelHeader from './ChannelHeader'
import RightRail from './RightRail'
import type { RailTab } from './RightRail'
import SettingsModal from './SettingsModal'
import { HealthBanner } from './banners'
import { Toasts } from './toasts'
import { NoConvState, EmptyConvOverlay } from './EmptyStates'
import { ActiveShareBanner, ScreenShareRoot } from '@/screenshare/ShareUi'
import { BeamSurface } from './BeamSurface'
import { UpdateBanner } from './UpdateBanner'
import { LaunchNudge } from './LaunchNudge'

// The main three-pane application shell (spec §2). A slim drag strip spans the
// top (empty, so macOS traffic lights sit alone); the team block lives at the
// top of the sidebar.

const FONT_PX: Record<'S' | 'M' | 'L', string> = { S: '14px', M: '15px', L: '16px' }


/**
 * The drag strip. Deliberately empty: on macOS the traffic lights live here,
 * and anything rendered alongside them risks colliding depending on how the
 * OS insets them. The team block sits in the sidebar below instead.
 */
function TitleBar() {
  return (
    <div
      style={{
        ...DRAG,
        height: isMac ? 36 : 32,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          width: 260,
          flexShrink: 0,
          background: 'var(--bg-sidebar)',
          borderRight: '1px solid var(--border-subtle)',
        }}
      />
      <div style={{ flex: 1, background: 'var(--bg-app)' }} />
    </div>
  )
}

export default function AppShell() {
  const activeConv = useStore((s) => s.activeConv)
  const settings = useStore((s) => s.settings)
  // 1.4 — which Settings section is open (null = closed) lives in the store:
  // the notifications popover opens it on "Notifications" from two panes that
  // have no way to reach this component.
  const settingsSection = useStore((s) => s.settingsSection)
  const openSettings = useStore((s) => s.openSettings)
  const closeSettings = useStore((s) => s.closeSettings)
  const [railOpen, setRailOpen] = useState(true)
  const [railTab, setRailTab] = useState<RailTab>('about')

  // Theme + font size (spec §2.6): 'system' clears the attribute, dark is the
  // token default; applied on boot and whenever settings change.
  const theme = settings?.theme ?? 'system'
  const fontSize = settings?.fontSize ?? 'M'
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    document.documentElement.style.setProperty('--text-msg', FONT_PX[fontSize])
  }, [fontSize])

  // Rail defaults: open in channels and groups (members matter there), closed
  // in DMs (spec §2.4) and in the team panes, which own the whole centre
  // column (spec §3). Groups (1.2) join the channel side here — unlike a DM's
  // fixed pair, a group's membership is exactly the thing worth surfacing.
  const convKind = useMemo(
    () =>
      activeConv === null
        ? 'none'
        : isTeamConv(activeConv)
          ? 'team'
          : isDmConv(activeConv)
            ? 'dm'
            : isGrpConv(activeConv)
              ? 'grp'
              : 'chan',
    [activeConv],
  )
  useEffect(() => {
    setRailOpen(convKind === 'chan' || convKind === 'grp')
    if (convKind !== 'none') setRailTab('about')
  }, [convKind])

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-app)',
        color: 'var(--text-1)',
        overflow: 'hidden',
      }}
    >
      <ChromeCss />
      <TitleBar />

      <div style={{ flex: 1, minHeight: 0, display: 'flex', ...NO_DRAG }}>
        <Sidebar onOpenSettings={() => openSettings()} />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {convKind === 'team' ? (
            <>
              <HealthBanner />
              {activeConv === TEAM_CONV.calendar ? <CalendarPane /> : <PrsPane />}
            </>
          ) : activeConv ? (
            <>
              <ChannelHeader
                conv={activeConv}
                railOpen={railOpen}
                railTab={railTab}
                onToggleRail={() => setRailOpen((v) => !v)}
                onOpenTab={(tab) => {
                  if (railOpen && railTab === tab) setRailOpen(false)
                  else {
                    setRailTab(tab)
                    setRailOpen(true)
                  }
                }}
              />
              <HealthBanner />
              <ActiveShareBanner conv={activeConv} />
              <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                <ChatPane conv={activeConv} />
                <EmptyConvOverlay conv={activeConv} />
              </div>
            </>
          ) : (
            <>
              <HealthBanner />
              <NoConvState />
            </>
          )}
        </div>

        {/* convKind is checked as well as railOpen: the rail-default effect only
            clears railOpen *after* the first render, and the rail knows nothing
            about team conversations. */}
        {railOpen && activeConv && convKind !== 'team' && (
          <RightRail conv={activeConv} tab={railTab} onTab={setRailTab} onClose={() => setRailOpen(false)} />
        )}
      </div>

      <Toasts />
      <Lightbox />
      <DiagramRoot />
      <ScreenShareRoot />
      <BeamSurface />
      <PrAlert />
      <UpdateBanner />
      <LaunchNudge />
      {settingsSection && <SettingsModal section={settingsSection} onClose={closeSettings} />}
    </div>
  )
}
