// Who owns Escape inside the diagram editor.
//
// Before 1.4 the rule was crude: an Escape whose target was inside `.excalidraw`
// was always Excalidraw's, except in fullscreen. That is right most of the time
// — Escape leaves a text element, drops a selection, closes the shape panel —
// but it also meant that an idle canvas swallowed the key, so the *only* way
// out of the editor was the header's Close button. Gil tested the packaged
// build with that button sitting under the window's drag strip (unclickable)
// and reported "I can't exit the diagram mode".
//
// So Escape escalates instead. It goes to Excalidraw only while Excalidraw
// genuinely has something of its own to cancel; otherwise it leaves fullscreen,
// and from a plain windowed editor with an idle canvas it closes the editor
// (through the usual dirty confirm).
//
// Pure: the caller reads the bits it needs off Excalidraw's `getAppState()`
// (see `canvasEscapeState` in DiagramEditor) and this decides.

export type EscapeAction =
  /** Let it through to Excalidraw — it has a text edit, a dialog or a selection to drop. */
  | 'excalidraw'
  /** Take the window out of fullscreen; a second Escape then closes. */
  | 'exit-fullscreen'
  /** Close the editor (the dirty confirm still applies). */
  | 'close'

export interface CanvasEscapeState {
  /** `appState.editingTextElement` — mid-typing inside a text element. */
  editingText: boolean
  /** `appState.openDialog` — the help / export / command-palette dialogs. */
  dialogOpen: boolean
  /** `appState.openMenu`, `openPopup`, `openSidebar` or an open context menu. */
  menuOpen: boolean
  /** Anything selected on the canvas — Escape deselects. */
  hasSelection: boolean
  /** `appState.activeTool.type`; anything but `selection` is a tool Escape cancels. */
  activeTool: string
  /** `appState.editingLinearElement` / `croppingElementId` — a live editing session. */
  editing: boolean
}

/**
 * `state` is `null` when the key did not come from the canvas (the header, the
 * title input, the live hint) or when the Excalidraw API is not up yet: then
 * nothing inside the canvas can be claiming it.
 */
export function escapeAction(state: CanvasEscapeState | null, fullscreen: boolean): EscapeAction {
  if (state !== null && canvasOwnsEscape(state)) return 'excalidraw'
  return fullscreen ? 'exit-fullscreen' : 'close'
}

/** Does Excalidraw have something to cancel right now? */
export function canvasOwnsEscape(s: CanvasEscapeState): boolean {
  return (
    s.editingText ||
    s.dialogOpen ||
    s.menuOpen ||
    s.editing ||
    s.hasSelection ||
    (s.activeTool !== '' && s.activeTool !== 'selection')
  )
}

/** An idle canvas: nothing selected, nothing open, the selection tool armed. */
export const IDLE_CANVAS: CanvasEscapeState = {
  editingText: false,
  dialogOpen: false,
  menuOpen: false,
  hasSelection: false,
  activeTool: 'selection',
  editing: false,
}
