import { describe, expect, it } from 'vitest'
import { MAC_TRAFFIC_LIGHT_INSET, WIN_CAPTION_INSET, overlayChromeInsets } from './overlayChrome'

describe('overlayChromeInsets', () => {
  it('clears the macOS traffic lights on the left in windowed mode', () => {
    expect(overlayChromeInsets('darwin', false)).toEqual({ left: MAC_TRAFFIC_LIGHT_INSET, right: 0 })
    // The lights end ≈82 px in (measured on the packaged build), so the inset
    // has to be past that — this is the regression Gil reported as "the name
    // of the diagram is under the window minimize buttons".
    expect(MAC_TRAFFIC_LIGHT_INSET).toBeGreaterThan(82)
  })

  it('clears the Windows caption buttons on the right in windowed mode', () => {
    expect(overlayChromeInsets('win32', false)).toEqual({ left: 0, right: WIN_CAPTION_INSET })
    // Three ~46 px buttons.
    expect(WIN_CAPTION_INSET).toBeGreaterThanOrEqual(138)
  })

  it('insets nothing in fullscreen — the OS hides its own chrome there', () => {
    expect(overlayChromeInsets('darwin', true)).toEqual({ left: 0, right: 0 })
    expect(overlayChromeInsets('win32', true)).toEqual({ left: 0, right: 0 })
  })

  it('insets nothing on platforms whose decorations live outside the page', () => {
    expect(overlayChromeInsets('linux', false)).toEqual({ left: 0, right: 0 })
    expect(overlayChromeInsets('freebsd', false)).toEqual({ left: 0, right: 0 })
  })
})
