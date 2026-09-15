// Which events reached this window over the push, during this session.
//
// One consumer so far: the message easter eggs (1.5), whose whole eligibility
// rule turns on "did this land while I had the app open, or is it history I
// scrolled back into?". The pane cannot answer that on its own. `loadTeam`
// prefetches every channel, DM and group log at boot so the sidebar can count
// unreads, so by the time anybody clicks a conversation its log is already
// loaded and "what the log held when the pane opened" contains messages that
// arrived live ten minutes earlier, in a pane that was not on screen. The push
// is the only place where "this is new" is still true, so it is recorded here,
// as the event goes by, for whoever asks later.
//
// Deliberately module state rather than a store slice: it is a set of ids with
// no render meaning — nothing re-renders when it grows — and putting it in the
// store would mean a new `{...s.set}` on every single event.

/**
 * Ids kept before the oldest is dropped. A busy day in a busy team is a few
 * hundred events; 2000 is far past that, and the set only has to outlive the
 * moment a reader walks into the conversation.
 */
export const LIVE_EVENT_CAP = 2000

const live = new Set<string>()

/** Record an event stem that just arrived over the push. */
export function noteLiveEvent(id: string): void {
  if (!id || live.has(id)) return
  live.add(id)
  if (live.size > LIVE_EVENT_CAP) {
    // A Set iterates in insertion order, so the first entry is the oldest.
    const oldest = live.values().next()
    if (!oldest.done) live.delete(oldest.value)
  }
}

/** Did this event stem arrive over the push during this session? */
export function arrivedLive(id: string): boolean {
  return live.has(id)
}

/**
 * Forget everything. Called on a folder switch (the ids belong to the team
 * that just went away) and by the tests.
 */
export function resetLiveEvents(): void {
  live.clear()
}

/** Tests only: how many ids are held right now. */
export function liveEventCount(): number {
  return live.size
}
