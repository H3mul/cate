import { describe, expect, it } from 'vitest'
import { commitDrop, type CommitContext } from './commit'
import { createDockStore } from '../stores/dockStore'
import { collectPanelIds } from '../../shared/collectPanelIds'
import type { DragSource } from './types'

function scene(panelIds: string[]) {
  const dock = createDockStore()
  for (const id of panelIds) dock.getState().dockPanel(id, 'center')
  const stackId = dock.getState().zones.center.layout!.id
  return { dock, stackId }
}

function drop(dock: ReturnType<typeof createDockStore>, stackId: string, panelId: string, index?: number) {
  const source: DragSource = {
    panelId,
    origin: { kind: 'dock-tab', dockStoreApi: dock, zone: 'center', stackId },
  } as DragSource
  const ctx = { workspaceId: 'ws' } as CommitContext
  return commitDrop(source, { kind: 'dock-tab', dockStoreApi: dock, stackId, index }, { id: panelId, type: 'editor', title: panelId }, ctx)
}

describe('dock-tab drop reorders within a stack', () => {
  it.each([
    ['first tab to the middle', 'a', 1, ['b', 'a', 'c']],
    ['last tab to the front', 'c', 0, ['c', 'a', 'b']],
    ['middle tab to the end', 'b', 2, ['a', 'c', 'b']],
  ])('%s', async (_name, dragged, index, expected) => {
    const { dock, stackId } = scene(['a', 'b', 'c'])
    await drop(dock, stackId, dragged as string, index as number)
    expect(collectPanelIds(dock.getState().zones.center.layout)).toEqual(expected)
  })

  it('without an index the tab is appended (previous behaviour)', async () => {
    const { dock, stackId } = scene(['a', 'b', 'c'])
    await drop(dock, stackId, 'a')
    expect(collectPanelIds(dock.getState().zones.center.layout)).toEqual(['b', 'c', 'a'])
  })

  it('the dropped tab becomes active', async () => {
    const { dock, stackId } = scene(['a', 'b', 'c'])
    await drop(dock, stackId, 'c', 0)
    const layout = dock.getState().zones.center.layout
    expect(layout?.type === 'tabs' && layout.activeIndex).toBe(0)
  })
})
