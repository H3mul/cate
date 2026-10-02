// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../stores/appStore'
import { createDockStore } from '../../stores/dockStore'
import { getOrCreateCanvasStoreForPanel } from '../../stores/canvasStore'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { registerWorkspaceDockStore } from './dockRegistry'
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
      ].map((p) => [p.id, p])),
    }] as never,
  })
  const dock = createDockStore()
  registerWorkspaceDockStore(ws, dock)
  for (const id of ['cv', 'd1', 'd2']) dock.getState().dockPanel(id, 'center')
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
    expect(collectPanelIds(layout)).toEqual(['d2', 'cv', 'd1'])
    expect(layout.type === 'tabs' && layout.panelIds[layout.activeIndex]).toBe('d1')
  })

  it('reordering inside a canvas only records a sidebar order — canvas state is untouched', () => {
    const before = JSON.stringify(s.canvas.getState().nodes)
    expect(move(s.ws, 't2', 't1', 'before', ['t1', 't2'])).toBe(true)
    expect(JSON.stringify(s.canvas.getState().nodes)).toBe(before)
    expect(useAppStore.getState().workspaces[0].panels.cv.sidebarOrder).toEqual(['t2', 't1'])
  })

  it('drops a docked panel into a canvas: node added, undocked, ordered', () => {
    expect(move(s.ws, 'd1', 'cv', 'into', ['t1', 't2'])).toBe(true)
    expect(s.canvas.getState().nodeForPanel('d1')).toBeTruthy()
    expect(collectPanelIds(s.dock.getState().zones.center.layout)).toEqual(['cv', 'd2'])
    expect(useAppStore.getState().workspaces[0].panels.cv.sidebarOrder).toEqual(['d1', 't1', 't2'])
  })

  it('drags a canvas child out to the dock at a position', () => {
    expect(move(s.ws, 't1', 'd2', 'before', ['t1', 't2'])).toBe(true)
    const node = s.canvas.getState().nodes[s.canvas.getState().nodeForPanel('t1') ?? '']
    expect(!node || node.animationState === 'exiting').toBe(true) // removal animates out
    expect(collectPanelIds(s.dock.getState().zones.center.layout)).toEqual(['cv', 'd1', 't1', 'd2'])
  })

  it('refuses to put a canvas inside a canvas', () => {
    expect(move(s.ws, 'cv', 'cv', 'into')).toBe(false)
  })
})
