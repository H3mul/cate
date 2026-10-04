// =============================================================================
// sidebarMove — apply a sidebar drag-and-drop of one panel row.
//
// A row can be dropped `before` / `after` another row, or `into` a canvas or
// container row (both are "hosts": they group children in the sidebar).
// Where it lands depends on the reference row:
//   - a docked row            → the panel is placed at that spot in the dock's
//                               tab order (so the tab tokens reorder too);
//   - a canvas child / canvas → the panel becomes a child of that canvas and its
//                               sidebar position is recorded in the canvas
//                               panel's `sidebarOrder`. Reordering within a
//                               canvas touches ONLY that list — never the nodes,
//                               z-order or viewport.
//   - a container child /     → the panel is placed at that spot in the
//     container                 container's layout, so its tab tokens reorder
//                               too. Split membership is not chosen by the drop:
//                               it joins the stack of the prior sibling.
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
import { containerZones, emptyContainerLayout, getContainerDockStore } from '../../panels/containerDockRegistry'
import { prepareTerminalRemount } from '../../drag/terminalRemount'
import { terminalRegistry } from '../terminal/terminalRegistry'
import { ensureCanvasOpsForPanel, resolvePanelLocation } from './canvasAccess'
import { getWorkspaceDockStore } from './dockRegistry'
import { placeInOrder } from './sidebarOrder'

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
    refForOrder = childrenOf(ref.id)[0] // first child, inserted before it
    after = false
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
  // Place the panel in a container's layout at the sidebar position. A "before"
  // drop joins the prior sibling's stack (just after it); only the first row
  // goes before its own successor. Works on the live store, or on a scratch
  // store seeded from the mirrored layout when the container isn't mounted.
  const placeInContainer = (hostId: string): void => {
    const live = getContainerDockStore(hostId)
    const store = live ?? createDockStore({ zones: containerZones(ws.panels[hostId]?.containerLayout ?? emptyContainerLayout()) })
    const layout = store.getState().zones.center.layout
    const siblings = collectPanelIds(layout).filter((id) => id !== panelId)
    const at = refForOrder ? siblings.indexOf(refForOrder) : -1
    let anchor = at < 0 ? siblings[siblings.length - 1] : refForOrder
    let anchorAfter = at < 0 || after
    if (at > 0 && !after) { anchor = siblings[at - 1]; anchorAfter = true }
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
    if (!live) app.setPanelContainerLayout(workspaceId, hostId, store.getState().zones.center.layout ?? emptyContainerLayout())
  }

  if (destHost) {
    if (fromHost !== destHost.id) {
      prepareTerminalRemount(panelId, panel.type, terminalRegistry)
      if (fromHost) removeFromHost(fromHost)
      else dock.getState().undockPanel(panelId)
    }
    if (destHost.type === 'container') {
      placeInContainer(destHost.id)
    } else {
      if (fromHost !== destHost.id) {
        ensureCanvasOpsForPanel(destHost.id).addNodeAndFocus(
          panelId, panel.type, undefined, { ...PANEL_CANVAS_DROP_SIZES[panel.type] }, false,
        )
      }
      // Sidebar-only: record the order (the canvas itself is untouched on a reorder).
      const order = placeInOrder(childrenOf(destHost.id).filter((id) => id !== panelId), panelId, refForOrder, after)
      app.setPanelSidebarOrder(workspaceId, destHost.id, order)
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

  // The panel left its old host: drop it from that host's sidebar order.
  if (fromHost && fromHost !== destHost?.id) {
    const old = ws.panels[fromHost]?.sidebarOrder
    if (old?.includes(panelId)) app.setPanelSidebarOrder(workspaceId, fromHost, old.filter((id) => id !== panelId))
  }
  return true
}
