import { describe, expect, it } from 'vitest'
import { IDLE_CANVAS, escapeAction } from './escape'

const busy = (over: Partial<typeof IDLE_CANVAS>) => ({ ...IDLE_CANVAS, ...over })

describe('escapeAction', () => {
  it('closes the editor from an idle canvas in windowed mode', () => {
    // The bug Gil hit: this used to return to Excalidraw, which did nothing,
    // and the only other way out (the Close button) was under the drag strip.
    expect(escapeAction(IDLE_CANVAS, false)).toBe('close')
  })

  it('leaves fullscreen first, then closes on the next Escape', () => {
    expect(escapeAction(IDLE_CANVAS, true)).toBe('exit-fullscreen')
    expect(escapeAction(IDLE_CANVAS, false)).toBe('close')
  })

  it('closes when the key did not come from the canvas at all', () => {
    expect(escapeAction(null, false)).toBe('close')
    expect(escapeAction(null, true)).toBe('exit-fullscreen')
  })

  it('leaves Escape to Excalidraw while it has something to cancel', () => {
    for (const state of [
      busy({ editingText: true }),
      busy({ dialogOpen: true }),
      busy({ menuOpen: true }),
      busy({ editing: true }),
      busy({ hasSelection: true }),
      busy({ activeTool: 'rectangle' }),
      busy({ activeTool: 'eraser' }),
    ]) {
      expect(escapeAction(state, false)).toBe('excalidraw')
      // …and in fullscreen too: a text edit being cancelled must not also rip
      // the window out of fullscreen.
      expect(escapeAction(state, true)).toBe('excalidraw')
    }
  })

  it('treats the selection tool (and an unknown empty tool) as idle', () => {
    expect(escapeAction(busy({ activeTool: 'selection' }), false)).toBe('close')
    expect(escapeAction(busy({ activeTool: '' }), false)).toBe('close')
  })
})
