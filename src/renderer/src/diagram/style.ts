// The look a brand-new diagram starts in.
//
// 1.4, tester feedback: "the default style of the diagrams should make them
// look clean and high value. Remove any pencil style and make it start with
// beautiful clean style." Excalidraw ships a sketchbook: Excalifont (a
// hand-drawn face), `roughness: 1` (hand-drawn strokes), 2 px bowed lines. That
// is charming and it is exactly wrong for a diagram somebody is about to send
// into a work conversation.
//
// So a fresh canvas is seeded with crisp defaults instead: straight 1 px
// strokes, rounded corners, a solid fill, Nunito for text, a white page. These
// are only *defaults for the next element drawn* — nothing here restyles
// elements that already exist, and a scene that arrives with its own `appState`
// (a received diagram, an imported file, a restored draft) keeps every value it
// brought with it.
//
// Pure and dependency-free on purpose: `@excalidraw/excalidraw` cannot be
// imported from a node test, so the font id is spelled out here and the caller
// passes the real `FONT_FAMILY.Nunito` in, which keeps the two honest.

/**
 * `FONT_FAMILY.Nunito` from `@excalidraw/excalidraw` 0.18 (Excalifont, the
 * hand-drawn default, is 5). Nunito's five woff2 faces are among the ones
 * `scripts/sync-excalidraw-assets.mjs` copies, so it renders offline; Xiaolai
 * is not (see assets.ts) and must never be chosen here.
 */
export const NUNITO_FONT_FAMILY = 6

/**
 * Every default a fresh scene opens with. Spelled out rather than "whatever
 * Excalidraw's are minus roughness", because the point is that the result is
 * predictable — and because Excalidraw's own defaults have moved between
 * releases before.
 */
export const CLEAN_APP_STATE = {
  /** 0 = architect: dead-straight strokes. Excalidraw's own default is 1 (hand-drawn). */
  currentItemRoughness: 0,
  /** Thin. Excalidraw's default is 2 ("bold"), which reads as a marker sketch. */
  currentItemStrokeWidth: 1,
  currentItemStrokeStyle: 'solid',
  currentItemFontFamily: NUNITO_FONT_FAMILY,
  /** Rounded corners and joins — the thing that makes a box look designed. */
  currentItemRoundness: 'round',
  /** Excalidraw's near-black; explicit so a theme swap cannot drift it. */
  currentItemStrokeColor: '#1e1e1e',
  currentItemBackgroundColor: 'transparent',
  /** When a fill *is* picked it is flat, not hachure (the crayon shading). */
  currentItemFillStyle: 'solid',
  currentItemOpacity: 100,
  viewBackgroundColor: '#ffffff',
  /** No graph paper under a clean drawing. */
  gridModeEnabled: false,
  gridSize: 20,
} as const

/**
 * The `appState` an editor should open with.
 *
 * `sceneAppState` is whatever came out of the file/draft/message being opened
 * (already sanitised). It wins key by key: a diagram that was drawn rough stays
 * rough when you open it, and only a scene that never had an opinion — a new
 * diagram, or a scene serialised without `appState` — gets the clean defaults.
 */
export function initialAppState(
  sceneAppState?: Record<string, unknown> | null,
  fontFamily: number = NUNITO_FONT_FAMILY,
): Record<string, unknown> {
  return {
    ...CLEAN_APP_STATE,
    currentItemFontFamily: fontFamily,
    ...(sceneAppState ?? {}),
  }
}

/** True when a scene carries no styling opinion of its own — i.e. it is fresh. */
export function isFreshScene(sceneAppState?: Record<string, unknown> | null): boolean {
  return !sceneAppState || Object.keys(sceneAppState).length === 0
}
