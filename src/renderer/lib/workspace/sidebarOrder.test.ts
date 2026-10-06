import { describe, expect, it } from 'vitest'
import type { WindowDockState } from '../../../shared/types'
import { canvasNodeGroups, flattenDockOrder, sortByOrder, stackIdByPanel } from './sidebarOrder'

const zone = (position: 'left' | 'right' | 'bottom' | 'center', panelIds: string[]) => ({
  position, visible: true, size: 0,
  layout: panelIds.length ? { type: 'tabs' as const, id: `s-${position}`, panelIds, activeIndex: 0 } : null,
})

describe('flattenDockOrder', () => {
  it('lists the center zone first, then the side zones, in tab order', () => {
    const zones: WindowDockState = {
      left: zone('left', ['l1']), right: zone('right', ['r1']), bottom: zone('bottom', ['b1']),
      center: zone('center', ['c1', 'c2']),
    }
    expect(flattenDockOrder(zones)).toEqual(['c1', 'c2', 'l1', 'r1', 'b1'])
  })
})

describe('sortByOrder', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
  it('orders listed ids first and keeps the rest in input order', () => {
    expect(sortByOrder(items, ['c', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd'])
  })
  it('is a no-op without an order', () => {
    expect(sortByOrder(items, undefined)).toBe(items)
  })
})

describe('stackIdByPanel', () => {
  it('maps every panel to its tab stack across a split tree', () => {
    const layout = {
      type: 'split', id: 's', direction: 'horizontal', ratios: [0.5, 0.5], children: [
        { type: 'tabs', id: 'a', panelIds: ['t1', 't2'], activeIndex: 0 },
        { type: 'split', id: 's2', direction: 'vertical', ratios: [0.5, 0.5], children: [
          { type: 'tabs', id: 'b', panelIds: ['t3'], activeIndex: 0 },
          { type: 'tabs', id: 'c', panelIds: ['t4'], activeIndex: 0 },
        ] },
      ],
    } as never
    expect(stackIdByPanel(layout)).toEqual({ t1: 'a', t2: 'a', t3: 'b', t4: 'c' })
    expect(stackIdByPanel(null)).toEqual({})
  })
})

describe('canvasNodeGroups', () => {
  it('orders windows by creation and maps each tab to its window', () => {
    const tabs = (id: string, panelIds: string[]) => ({ type: 'tabs', id, panelIds, activeIndex: 0 }) as never
    const groups = canvasNodeGroups([
      { id: 'n2', creationIndex: 2, dockLayout: tabs('s2', ['c']) },
      { id: 'n1', creationIndex: 1, dockLayout: tabs('s1', ['a', 'b']) },
    ])
    expect(groups.order).toEqual(['a', 'b', 'c'])
    expect(groups.nodeOf).toEqual({ a: 'n1', b: 'n1', c: 'n2' })
  })
})
