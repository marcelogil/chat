import { describe, expect, it } from 'vitest'
import { CLEAN_APP_STATE, NUNITO_FONT_FAMILY, initialAppState, isFreshScene } from './style'

describe('CLEAN_APP_STATE', () => {
  it('has no pencil left in it', () => {
    // The four that made every diagram look hand-drawn.
    expect(CLEAN_APP_STATE.currentItemRoughness).toBe(0)
    expect(CLEAN_APP_STATE.currentItemStrokeWidth).toBe(1)
    expect(CLEAN_APP_STATE.currentItemFillStyle).toBe('solid')
    // …and Excalifont (5) is the one font id that must never appear here.
    expect(CLEAN_APP_STATE.currentItemFontFamily).toBe(NUNITO_FONT_FAMILY)
    expect(CLEAN_APP_STATE.currentItemFontFamily).not.toBe(5)
  })

  it('starts on a white page with round joins and no grid', () => {
    expect(CLEAN_APP_STATE.viewBackgroundColor).toBe('#ffffff')
    expect(CLEAN_APP_STATE.currentItemRoundness).toBe('round')
    expect(CLEAN_APP_STATE.currentItemStrokeColor).toBe('#1e1e1e')
    expect(CLEAN_APP_STATE.currentItemBackgroundColor).toBe('transparent')
    expect(CLEAN_APP_STATE.gridModeEnabled).toBe(false)
  })
})

describe('initialAppState', () => {
  it('carries the clean defaults for a fresh scene', () => {
    // A new diagram: no scene at all, or a scene serialised without appState.
    for (const scene of [null, undefined, {}]) {
      const st = initialAppState(scene)
      expect(st.currentItemRoughness).toBe(0)
      expect(st.currentItemStrokeWidth).toBe(1)
      expect(st.currentItemFontFamily).toBe(NUNITO_FONT_FAMILY)
      expect(st.currentItemRoundness).toBe('round')
      expect(st.currentItemFillStyle).toBe('solid')
      expect(st.viewBackgroundColor).toBe('#ffffff')
      expect(st.gridModeEnabled).toBe(false)
    }
  })

  it("lets an existing scene's own appState win, key by key", () => {
    // A rough diagram somebody sent us opens exactly as they drew it.
    const st = initialAppState({ currentItemRoughness: 2, viewBackgroundColor: '#fffce8' })
    expect(st.currentItemRoughness).toBe(2)
    expect(st.viewBackgroundColor).toBe('#fffce8')
    // …while the keys that scene never mentioned still come from the defaults.
    expect(st.currentItemStrokeWidth).toBe(1)
    expect(st.currentItemFontFamily).toBe(NUNITO_FONT_FAMILY)
  })

  it('takes the font id from the caller, so it tracks FONT_FAMILY.Nunito', () => {
    expect(initialAppState(null, 42).currentItemFontFamily).toBe(42)
    // …but a scene that named a font still keeps it.
    expect(initialAppState({ currentItemFontFamily: 5 }, 42).currentItemFontFamily).toBe(5)
  })

  it('does not restyle elements — it only seeds appState', () => {
    expect(Object.keys(initialAppState(null)).some((k) => k === 'elements')).toBe(false)
  })
})

describe('isFreshScene', () => {
  it('is true only when nothing brought an opinion', () => {
    expect(isFreshScene(null)).toBe(true)
    expect(isFreshScene(undefined)).toBe(true)
    expect(isFreshScene({})).toBe(true)
    expect(isFreshScene({ currentItemRoughness: 1 })).toBe(false)
  })
})
