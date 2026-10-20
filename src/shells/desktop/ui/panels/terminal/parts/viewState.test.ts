import { describe, expect, it } from 'vitest'
import { lineToRestore, linesFromBottom } from './viewState'

describe('terminal view state', () => {
  it('counts the scroll position from the live bottom', () => {
    expect(linesFromBottom({ baseY: 100, viewportY: 100 })).toBe(0)
    expect(linesFromBottom({ baseY: 100, viewportY: 40 })).toBe(60)
    expect(linesFromBottom({ baseY: 0, viewportY: 0 })).toBe(0)
  })

  it('restores to the same distance from the bottom of a rebuilt buffer, clamped to it', () => {
    expect(lineToRestore({ baseY: 120 }, 60)).toBe(60)
    expect(lineToRestore({ baseY: 30 }, 60)).toBe(0) // the replay is shorter than before
  })

  it('stays at the bottom for nothing saved, zero or junk', () => {
    for (const saved of [undefined, null, 0, -3, NaN, Infinity, '5', {}]) expect(lineToRestore({ baseY: 100 }, saved)).toBeNull()
  })
})
