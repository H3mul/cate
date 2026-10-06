// =============================================================================
// sidebarMove — apply a sidebar drag-and-drop of one panel row.
//
// A row can be dropped `before` / `after` another row, or `into` a canvas or
// container row (both are "hosts": they group children in the sidebar). `into`
// appends after the host's last member; `after` on a host row means after the
// whole group (a sibling of the host), not as its first child.
// Where it lands depends on the reference row:
//   - a docked row            → the panel is placed at that spot in the dock's
//                               tab order (so the tab tokens reorder too);
//   - a canvas child          → the panel joins that row's window (canvas node)
//                               as a tab at that spot. A canvas's windows are
//                               groups of tabs; windows never change shape.
//   - a canvas row / the      → `into`: the panel spawns a new window.
//     trailing slot
//   - a container child /     → the panel is placed at that spot in the
//     container                 container's layout, so its tab tokens reorder
//                               too. It joins the split group (tab stack) of the
//                               row it is dropped before/after.
// Moving between parents (dock ↔ canvas ↔ container) also moves the panel
// itself; a running terminal is armed to reconnect to its PTY first.
// =============================================================================

import type { StoreApi } from 'zustand'
import { canContain } from '../../../shared/panels'
import { ALL_ZONES, PANEL_CANVAS_DROP_SIZES, type PanelType } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { removePanelFromTree, createDockStore, type DockStore } from '../../stores/dockStore'
import { findStackContainingPanel, findStackContainingPanelAcrossZones, findZoneForStack, visitDockTree } from '../../stores/dockTreeUtils'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { getNodeDockStore } from '../../panels/nodeDockRegistry'
import { containerZones, emptyContainerLayout, getContainerDockStore } from '../../panels/containerDockRegistry'
import { prepareTerminalRemount } from '../../drag/terminalRemount'
import { terminalRegistry } from '../terminal/terminalRegistry'
import { ensureCanvasOpsForPanel, getNodeDockLayout, resolvePanelLocation } from './canvasAccess'
import { getWorkspaceDockStore } from './dockRegistry'

export type SidebarDropZone = 'before' | 'after' | 'into'

export interface SidebarMove {
  workspaceId: string
  panelId: string
  /** The row dropped on; null = the end of the top-level list. */
  refId: string | null
  zone: SidebarDropZone
  /** The sidebar's current child order for a canvas (as displayed). */
  childrenOf: (canvasPanelId: string) => string[]
}

type Host = { id: string; type: 'canvas' | 'container' }
const isHost = (type: PanelType | undefined): type is 'canvas' | 'container' => type === 'canvas' || type === 'container'

/** The canvas/container a drop lands in, or null for the dock. */
function destinationHost(
  workspaceId: string,
  ws: { panels: Record<string, { id: string; type: PanelType }> },
  ref: { id: string; type: PanelType } | null,
  zone: SidebarDropZone,
): Host | null {
  if (!ref) return null
  if (zone === 'into' && isHost(ref.type)) return { id: ref.id, type: ref.type }
  const loc = resolvePanelLocation(workspaceId, ref.id)
  const id = loc?.kind === 'canvas' ? loc.canvasPanelId : loc?.kind === 'container' ? loc.containerPanelId : null
  const type = id ? ws.panels[id]?.type : undefined
  return id && isHost(type) ? { id, type } : null
}

/** True when `hostId` is `panelId` or nested (at any depth) inside it. */
function isInside(workspaceId: string, panelId: string, hostId: string): boolean {
  for (let id: string | null = hostId, guard = 0; id && guard < 32; guard++) {
    if (id === panelId) return true
    const loc = resolvePanelLocation(workspaceId, id)
    id = loc?.kind === 'canvas' ? loc.canvasPanelId : loc?.kind === 'container' ? loc.containerPanelId : null
  }
  return false
}

/** Can `panelId` be dropped at `refId`/`zone`? Cheap enough to call on every
 *  dragover to decide whether to show a drop indicator. */
export function canMoveInSidebar(
  ws: { panels: Record<string, { id: string; type: PanelType }> } | undefined,
  panelId: string,
  refId: string | null,
  zone: SidebarDropZone,
  workspaceId?: string,
): boolean {
  const panel = ws?.panels[panelId]
  const ref = refId ? ws?.panels[refId] : null
  if (!ws || !panel || (refId && !ref) || refId === panelId) return false
  if (zone === 'into' && !isHost(ref?.type)) return false
  if (!workspaceId) return true
  const host = destinationHost(workspaceId, ws, ref ?? null, zone)
  if (!host) return true
  // Hosts' containment rules (no canvas-in-canvas, no container-in-container),
  // and never drop a panel into itself or one of its own descendants.
  return canContain(host.type, panel.type) && !isInside(workspaceId, panelId, host.id)
}

type Stack = { id: string; panelIds: string[]; activeIndex: number }

function activePanelByStack(dock: StoreApi<DockStore>): Map<string, string> {
  const active = new Map<string, string>()
  const zones = dock.getState().zones
  for (const zone of ALL_ZONES) {
    visitDockTree(zones[zone].layout, (node) => {
      if (node.type === 'tabs') {
        const id = node.panelIds[node.activeIndex]
        if (id) active.set(node.id, id)
      }
    })
  }
  return active
}

/** A reorder shouldn't change which tab is showing in any stack. */
function restoreActiveTabs(dock: StoreApi<DockStore>, before: Map<string, string>): void {
  const zones = dock.getState().zones
  for (const zone of ALL_ZONES) {
    visitDockTree(zones[zone].layout, (node) => {
      if (node.type !== 'tabs') return
      const prev = before.get(node.id)
      const index = prev ? node.panelIds.indexOf(prev) : -1
      if (index >= 0 && index !== node.activeIndex) dock.getState().setActiveTab(node.id, index)
    })
  }
}

export function movePanelInSidebar(move: SidebarMove): boolean {
  const { workspaceId, panelId, refId, zone, childrenOf } = move
  const app = useAppStore.getState()
  const ws = app.getWorkspace(workspaceId)
  if (!canMoveInSidebar(ws, panelId, refId, zone, workspaceId) || !ws) return false
  const dock = getWorkspaceDockStore(workspaceId)
  if (!dock) return false
  const panel = ws.panels[panelId]
  const ref = refId ? ws.panels[refId] : null

  // --- Destination ----------------------------------------------------------
  const destHost = destinationHost(workspaceId, ws, ref, zone)
  let refForOrder: string | undefined
  let after = zone !== 'before'
  if (ref && zone === 'into' && destHost?.id === ref.id) {
    // Dropping on a host row is the same as dropping after its last member.
    refForOrder = childrenOf(ref.id).filter((id) => id !== panelId).pop()
    after = true
  } else if (ref) {
    refForOrder = ref.id
  }

  const from = resolvePanelLocation(workspaceId, panelId)
  const fromHost = from?.kind === 'canvas' ? from.canvasPanelId : from?.kind === 'container' ? from.containerPanelId : null
  const activeBefore = activePanelByStack(dock)

  // --- Move -------------------------------------------------------------------
  const removeFromHost = (hostId: string): void => {
    if (ws.panels[hostId]?.type === 'canvas') { ensureCanvasOpsForPanel(hostId).removeNodeForPanel(panelId); return }
    const live = getContainerDockStore(hostId)
    if (live) { live.getState().undockPanel(panelId); return }
    const layout = ws.panels[hostId]?.containerLayout
    const next = layout && removePanelFromTree(layout, panelId)
    app.setPanelContainerLayout(workspaceId, hostId, next || emptyContainerLayout())
  }
  // Place the panel in a mini-dock (a container's layout or a canvas window's
  // tabs) at the sidebar position: it joins the reference row's own group (tab
  // stack), before or after it. The sidebar draws a separator between groups, so
  // each side of it is its own drop slot.
  const placeInMiniDock = (store: StoreApi<DockStore>): void => {
    const layout = store.getState().zones.center.layout
    const siblings = collectPanelIds(layout).filter((id) => id !== panelId)
    const at = refForOrder ? siblings.indexOf(refForOrder) : -1
    const anchor = at < 0 ? siblings[siblings.length - 1] : refForOrder
    const anchorAfter = at < 0 || after
    const stack = anchor && layout ? findStackContainingPanel(layout, anchor) : null
    const activeInStore = activePanelByStack(store)
    if (stack && anchor) {
      const peers = stack.panelIds.filter((id) => id !== panelId)
      const i = peers.indexOf(anchor)
      store.getState().dockPanel(panelId, 'center', { type: 'tab', stackId: stack.id, index: anchorAfter ? i + 1 : i }, false)
    } else {
      store.getState().dockPanel(panelId, 'center', undefined, false)
    }
    restoreActiveTabs(store, activeInStore)
  }
  // Live store when mounted, else a scratch store seeded from the persisted
  // layout whose result is written back.
  const placeInContainer = (hostId: string): void => {
    const live = getContainerDockStore(hostId)
    const store = live ?? createDockStore({ zones: containerZones(ws.panels[hostId]?.containerLayout ?? emptyContainerLayout()) })
    placeInMiniDock(store)
    if (!live) app.setPanelContainerLayout(workspaceId, hostId, store.getState().zones.center.layout ?? emptyContainerLayout())
  }
  const placeInNode = (canvasId: string, nodeId: string): void => {
    const live = getNodeDockStore(canvasId, nodeId)
    const store = live ?? createDockStore({ zones: containerZones(getNodeDockLayout(canvasId, nodeId) ?? emptyContainerLayout()) })
    placeInMiniDock(store)
    const layout = store.getState().zones.center.layout
    if (!live && layout) ensureCanvasOpsForPanel(canvasId).storeApi.getState().setNodeDockLayout(nodeId, layout)
  }
  const leaveSource = (): void => {
    prepareTerminalRemount(panelId, panel.type, terminalRegistry)
    if (fromHost) removeFromHost(fromHost)
    else dock.getState().undockPanel(panelId)
  }

  if (destHost?.type === 'container') {
    if (fromHost !== destHost.id) leaveSource()
    placeInContainer(destHost.id)
  } else if (destHost) {
    // A canvas: each window (node) is a group of tabs. Dropping beside a row
    // joins that row's window; windows never change shape. Dropping on the
    // canvas row / trailing slot ("into") spawns a new window.
    const canvas = ensureCanvasOpsForPanel(destHost.id).storeApi.getState()
    const refNode = zone === 'into' || !ref ? null : canvas.nodeForPanel(ref.id)
    const ownNode = fromHost === destHost.id ? canvas.nodeForPanel(panelId) : null
    if (refNode && refNode === ownNode) {
      placeInNode(destHost.id, refNode) // reorder tabs within one window
    } else if (refNode) {
      leaveSource()
      placeInNode(destHost.id, refNode)
    } else {
      // Already alone in its own window: nothing to spawn.
      if (ownNode && collectPanelIds(getNodeDockLayout(destHost.id, ownNode)).length <= 1) return true
      leaveSource()
      ensureCanvasOpsForPanel(destHost.id).addNodeAndFocus(
        panelId, panel.type, undefined, { ...PANEL_CANVAS_DROP_SIZES[panel.type] }, false,
      )
    }
  } else {
    // Dock destination: a spot in the reference row's tab stack, or the end.
    const stack = refForOrder
      ? (findStackContainingPanelAcrossZones(dock.getState().zones, refForOrder) as Stack | null)
      : null
    if (fromHost) {
      prepareTerminalRemount(panelId, panel.type, terminalRegistry)
      removeFromHost(fromHost)
    }
    if (stack) {
      const stackZone = findZoneForStack(dock.getState().zones, stack.id) ?? 'center'
      const siblings = stack.panelIds.filter((id) => id !== panelId)
      const at = siblings.indexOf(refForOrder!)
      dock.getState().dockPanel(panelId, stackZone, { type: 'tab', stackId: stack.id, index: after ? at + 1 : at }, false)
    } else {
      dock.getState().dockPanel(panelId, 'center', undefined, false)
    }
    restoreActiveTabs(dock, activeBefore)
  }

  return true
}
