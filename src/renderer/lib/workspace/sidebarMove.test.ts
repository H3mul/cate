// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../stores/appStore'
import { createDockStore } from '../../stores/dockStore'
import { getOrCreateCanvasStoreForPanel } from '../../stores/canvasStore'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { registerWorkspaceDockStore } from './dockRegistry'
import { containerZones, registerContainerDockStore, unregisterContainerDockStore } from '../../panels/containerDockRegistry'
import { movePanelInSidebar } from './sidebarMove'

const panel = (id: string, type: string) => ({ id, type, title: id, isDirty: false })

function setup() {
  const ws = 'ws-move'
  useAppStore.setState({
    selectedWorkspaceId: ws,
    workspaces: [{
      id: ws, name: 'ws', color: '', rootPath: '/ws',
      panels: Object.fromEntries([
        panel('cv', 'canvas'), panel('t1', 'terminal'), panel('t2', 'editor'), panel('d1', 'browser'), panel('d2', 'editor'),
        { ...panel('ct', 'container'), containerLayout: { type: 'tabs', id: 'ct-stack', panelIds: ['c1', 'c2'], activeIndex: 0 } },
        panel('c1', 'editor'), panel('c2', 'terminal'),
      ].map((p) => [p.id, p])),
    }] as never,
  })
  const dock = createDockStore()
  registerWorkspaceDockStore(ws, dock)
  for (const id of ['cv', 'd1', 'd2', 'ct']) dock.getState().dockPanel(id, 'center')
  const canvas = getOrCreateCanvasStoreForPanel('cv')
  canvas.getState().addNode('t1', 'terminal')
  canvas.getState().addNode('t2', 'editor')
  return { ws, dock, canvas }
}

const move = (ws: string, panelId: string, refId: string | null, zone: 'before' | 'after' | 'into', children: string[] = []) =>
  movePanelInSidebar({ workspaceId: ws, panelId, refId, zone, childrenOf: () => children })

describe('movePanelInSidebar', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => { s = setup() })

  it('reorders docked rows, which reorders the dock tabs and keeps the active tab', () => {
    s.dock.getState().setActiveTab(s.dock.getState().zones.center.layout!.id, 1) // d1 active
    expect(move(s.ws, 'd2', 'cv', 'before')).toBe(true)
    const layout = s.dock.getState().zones.center.layout!
    expect(collectPanelIds(layout)).toEqual(['d2', 'cv', 'd1', 'ct'])
    expect(layout.type === 'tabs' && layout.panelIds[layout.activeIndex]).toBe('d1')
  })

  const tabsOf = (panelId: string): string[] => {
    const nodeId = s.canvas.getState().nodeForPanel(panelId)
    return nodeId ? collectPanelIds(s.canvas.getState().nodes[nodeId].dockLayout) : []
  }

  it('dropping beside another window\'s tab joins that window; windows keep their shape', () => {
    const node1 = s.canvas.getState().nodeForPanel('t1')!
    const shape = JSON.stringify({ o: s.canvas.getState().nodes[node1].origin, z: s.canvas.getState().nodes[node1].size })
    expect(move(s.ws, 't2', 't1', 'before', ['t1', 't2'])).toBe(true)
    expect(tabsOf('t1')).toEqual(['t2', 't1'])
    const after = s.canvas.getState().nodes[node1]
    expect(JSON.stringify({ o: after.origin, z: after.size })).toBe(shape)
    expect(s.canvas.getState().nodeForPanel('t2')).toBe(node1)
  })

  it('reorders tabs within one window', () => {
    move(s.ws, 't2', 't1', 'before', ['t1', 't2'])
    expect(move(s.ws, 't1', 't2', 'before', ['t2', 't1'])).toBe(true)
    expect(tabsOf('t1')).toEqual(['t1', 't2'])
  })

  it('dropping on the canvas (row or trailing slot) spawns a new window', () => {
    expect(move(s.ws, 'd1', 'cv', 'into', ['t1', 't2'])).toBe(true)
    const node = s.canvas.getState().nodeForPanel('d1')
    expect(node).toBeTruthy()
    expect(node).not.toBe(s.canvas.getState().nodeForPanel('t1'))
    expect(tabsOf('d1')).toEqual(['d1'])
    expect(collectPanelIds(s.dock.getState().zones.center.layout)).toEqual(['cv', 'd2', 'ct'])
  })

  it('a tab dragged out of a multi-tab window onto the canvas becomes its own window', () => {
    move(s.ws, 't2', 't1', 'before', ['t1', 't2'])
    expect(move(s.ws, 't2', 'cv', 'into', ['t2', 't1'])).toBe(true)
    expect(tabsOf('t1')).toEqual(['t1'])
    expect(tabsOf('t2')).toEqual(['t2'])
    expect(s.canvas.getState().nodeForPanel('t2')).not.toBe(s.canvas.getState().nodeForPanel('t1'))
  })

  it('a lone window dropped on the canvas stays as it is', () => {
    const node = s.canvas.getState().nodeForPanel('t1')
    expect(move(s.ws, 't1', 'cv', 'into', ['t1', 't2'])).toBe(true)
    expect(s.canvas.getState().nodeForPanel('t1')).toBe(node)
  })

  it('drops a docked panel beside a canvas tab: joins that window at that spot', () => {
    expect(move(s.ws, 'd1', 't1', 'after', ['t1', 't2'])).toBe(true)
    expect(tabsOf('t1')).toEqual(['t1', 'd1'])
    expect(collectPanelIds(s.dock.getState().zones.center.layout)).not.toContain('d1')
  })

  it('drags a canvas child out to the dock at a position', () => {
    expect(move(s.ws, 't1', 'd2', 'before', ['t1', 't2'])).toBe(true)
    const node = s.canvas.getState().nodes[s.canvas.getState().nodeForPanel('t1') ?? '']
    expect(!node || node.animationState === 'exiting').toBe(true) // removal animates out
    expect(collectPanelIds(s.dock.getState().zones.center.layout)).toEqual(['cv', 'd1', 't1', 'd2', 'ct'])
  })

  it('refuses to put a canvas inside a canvas', () => {
    expect(move(s.ws, 'cv', 'cv', 'into')).toBe(false)
  })

  it('drops a docked panel into a container: added to its layout, undocked, ordered', () => {
    expect(move(s.ws, 'd1', 'ct', 'into', ['c1', 'c2'])).toBe(true)
    const p = useAppStore.getState().workspaces[0].panels
    expect(collectPanelIds(p.ct.containerLayout)).toEqual(['c1', 'c2', 'd1'])
    expect(collectPanelIds(s.dock.getState().zones.center.layout)).not.toContain('d1')
  })

  it('drags a container child out to the dock and drops it from the container', () => {
    expect(move(s.ws, 'c1', 'd2', 'before', ['c1', 'c2'])).toBe(true)
    const p = useAppStore.getState().workspaces[0].panels
    expect(collectPanelIds(p.ct.containerLayout)).toEqual(['c2'])
    expect(collectPanelIds(s.dock.getState().zones.center.layout)).toContain('c1')
  })

  it('reordering inside a container reorders its tab tokens (the layout)', () => {
    expect(move(s.ws, 'c2', 'c1', 'before', ['c1', 'c2'])).toBe(true)
    const p = useAppStore.getState().workspaces[0].panels
    expect(collectPanelIds(p.ct.containerLayout)).toEqual(['c2', 'c1'])
  })

  it('reordering in a mounted container updates the live store and keeps the active tab', () => {
    const live = createDockStore({ zones: containerZones(useAppStore.getState().workspaces[0].panels.ct.containerLayout!) })
    registerContainerDockStore('ct', live)
    expect(move(s.ws, 'c2', 'c1', 'before', ['c1', 'c2'])).toBe(true)
    const layout = live.getState().zones.center.layout!
    expect(collectPanelIds(layout)).toEqual(['c2', 'c1'])
    expect(layout.type === 'tabs' && layout.panelIds[layout.activeIndex]).toBe('c1')
    unregisterContainerDockStore('ct', live)
  })

  it('a drop before/after a row joins that row\'s own split group', () => {
    const split = { type: 'split', id: 'sp', direction: 'horizontal', ratios: [0.5, 0.5], children: [
      { type: 'tabs', id: 'a', panelIds: ['c1'], activeIndex: 0 }, { type: 'tabs', id: 'b', panelIds: ['c2'], activeIndex: 0 },
    ] }
    useAppStore.getState().setPanelContainerLayout(s.ws, 'ct', split as never)
    expect(move(s.ws, 'd1', 'c2', 'before', ['c1', 'c2'])).toBe(true)
    const layout = useAppStore.getState().workspaces[0].panels.ct.containerLayout as never as { children: { panelIds: string[] }[] }
    expect(layout.children.map((c) => c.panelIds)).toEqual([['c1'], ['d1', 'c2']])
    expect(move(s.ws, 'd2', 'c1', 'after', ['c1', 'd1', 'c2'])).toBe(true)
    const next = useAppStore.getState().workspaces[0].panels.ct.containerLayout as never as { children: { panelIds: string[] }[] }
    expect(next.children.map((c) => c.panelIds)).toEqual([['c1', 'd2'], ['d1', 'c2']])
  })

  it('dragging the last member out of a split group removes the group and its split', () => {
    const split = { type: 'split', id: 'sp', direction: 'horizontal', ratios: [0.5, 0.5], children: [
      { type: 'tabs', id: 'a', panelIds: ['c1'], activeIndex: 0 }, { type: 'tabs', id: 'b', panelIds: ['c2'], activeIndex: 0 },
    ] }
    useAppStore.getState().setPanelContainerLayout(s.ws, 'ct', split as never)
    expect(move(s.ws, 'c1', 'd2', 'before', ['c1', 'c2'])).toBe(true)
    expect(useAppStore.getState().workspaces[0].panels.ct.containerLayout).toMatchObject({ type: 'tabs', panelIds: ['c2'] })
  })

  it('dropping on a group row == dropping after its last member', () => {
    expect(move(s.ws, 'd1', 'ct', 'into', ['c1', 'c2'])).toBe(true)
    expect(move(s.ws, 'd2', 'c2', 'after', ['c1', 'c2', 'd1'])).toBe(true)
    expect(collectPanelIds(useAppStore.getState().workspaces[0].panels.ct.containerLayout)).toEqual(['c1', 'c2', 'd2', 'd1'])
  })

  it('"after" a group row drops OUT of the group, right after the group host', () => {
    expect(move(s.ws, 'c1', 'ct', 'after', ['c1', 'c2'])).toBe(true)
    const p = useAppStore.getState().workspaces[0].panels
    expect(collectPanelIds(p.ct.containerLayout)).toEqual(['c2'])
    expect(collectPanelIds(s.dock.getState().zones.center.layout)).toEqual(['cv', 'd1', 'd2', 'ct', 'c1'])
  })

  it('refuses container-in-container and a canvas dropped into its own descendant', () => {
    expect(move(s.ws, 'ct', 'ct', 'into')).toBe(false)
    s.dock.getState().undockPanel('ct')
    s.canvas.getState().addNode('ct', 'container')
    expect(move(s.ws, 'cv', 'ct', 'into')).toBe(false) // canvas → container on that canvas
  })
})
