// Where the OS puts its own window chrome, in the coordinates of a full-window
// overlay that draws its own top strip (the diagram editor, the lightbox, the
// screen-share viewer).
//
// Why this exists (1.4, tester feedback). The main window is frameless:
// `titleBarStyle: 'hiddenInset'` with the traffic lights at x 16 / y 11 on
// macOS, `titleBarStyle: 'hidden'` + a 44 px-tall `titleBarOverlay` at the
// top-right on Windows (src/main/index.ts). The OS still draws those controls
// on top of everything the page paints, and Chromium computes draggable
// regions (`-webkit-app-region`) from the whole DOM regardless of z-order — so
// a fixed `inset: 0` overlay does NOT shield the shell's drag strip
// underneath it. An overlay whose own controls sit in that band therefore has
// to do two things: subtract itself from the drag region (`NO_DRAG` on every
// control, `DRAG` on the strip so the window can still be moved by it), and
// keep its content clear of the OS chrome with the insets below.
//
// Pure and platform-parameterised so it is testable in node (the renderer's
// `window.bridge.platform` never enters here).

export interface ChromeInsets {
  /** Left padding the strip needs, in CSS px (macOS traffic lights). */
  left: number
  /** Right padding the strip needs, in CSS px (Windows caption buttons). */
  right: number
}

/**
 * macOS. The lights are placed at x 16 and measure ~12 px across with ~8 px
 * gaps, so the green one ends around x 82 — measured on Gil's 1.4 build:
 * red starts ≈25 px and green ends ≈82 px from the window's left edge. 90 px
 * leaves a small gap after the green light rather than tucking the first
 * control right against it.
 */
export const MAC_TRAFFIC_LIGHT_INSET = 90

/**
 * Windows. The `titleBarOverlay` caption buttons (minimise / maximise / close)
 * are ~46 px wide each and hug the top-right corner; 150 px clears all three
 * with a margin. The overlay is 44 px tall, which fits inside the 52 px
 * windowed header — so a single right padding is enough and the strip does not
 * have to grow.
 */
export const WIN_CAPTION_INSET = 150

/**
 * How far an overlay's top strip must stay clear of the OS's own controls.
 *
 * Fullscreen is always zero: macOS hides the traffic lights and Windows hides
 * the caption overlay, so the insets would only push the overlay's own chrome
 * into empty space.
 */
export function overlayChromeInsets(platform: string, fullscreen: boolean): ChromeInsets {
  if (fullscreen) return { left: 0, right: 0 }
  if (platform === 'darwin') return { left: MAC_TRAFFIC_LIGHT_INSET, right: 0 }
  if (platform === 'win32') return { left: 0, right: WIN_CAPTION_INSET }
  // Linux and anything else: the shell draws its own decorations outside the
  // web contents, so there is nothing to dodge.
  return { left: 0, right: 0 }
}
