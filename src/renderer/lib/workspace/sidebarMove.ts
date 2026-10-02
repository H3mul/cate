// =============================================================================
// sidebarMove — apply a sidebar drag-and-drop of one panel row.
//
// A row can be dropped `before` / `after` another row, or `into` a canvas row.
// Where it lands depends on the reference row:
//   - a docked row            → the panel is placed at that spot in the dock's
//                               tab order (so the tab tokens reorder too);
//   - a canvas child / canvas → the panel becomes a child of that canvas and its
//                               sidebar position is recorded in the canvas
//                               panel's `sidebarOrder`. Reordering within a
//                               canvas touches ONLY that list — never the nodes,
//                               z-order or viewport.
// Moving between parents (dock ↔ canvas, canvas ↔ canvas) also moves the panel
// itself; a running terminal is armed to reconnect to its PTY first.
// =============================================================================

import type { StoreApi } from 'zustand'
import { PANEL_DEFINITIONS } from '../../../shared/panels'
import { ALL_ZONES, PANEL_CANVAS_DROP_SIZES, type PanelType } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import type { DockStore } from '../../stores/dockStore'
import { findStackContainingPanelAcrossZones, findZoneForStack, visitDockTree } from '../../stores/dockTreeUtils'
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

/** Can `panelId` be dropped at `refId`/`zone`? Cheap enough to call on every
 *  dragover to decide whether to show a drop indicator. */
export function canMoveInSidebar(
  ws: { panels: Record<string, { id: string; type: PanelType }> } | undefined,
  panelId: string,
  refId: string | null,
  zone: SidebarDropZone,
): boolean {
  const panel = ws?.panels[panelId]
  const ref = refId ? ws?.panels[refId] : null
  if (!ws || !panel || (refId && !ref) || refId === panelId) return false
  // Canvases can't be hosted by canvases; other panel types always can.
  if (zone === 'into' && ref?.type === 'canvas') return PANEL_DEFINITIONS[panel.type].canLiveOnCanvas
  return true
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
  if (!canMoveInSidebar(ws, panelId, refId, zone) || !ws) return false
  const dock = getWorkspaceDockStore(workspaceId)
  if (!dock) return false
  const panel = ws.panels[panelId]
  const ref = refId ? ws.panels[refId] : null

  // --- Destination ----------------------------------------------------------
  let destCanvas: string | null = null
  let refForOrder: string | undefined
  let after = zone !== 'before'
  if (ref && zone === 'into' && ref.type === 'canvas') {
    destCanvas = ref.id
    refForOrder = childrenOf(ref.id)[0] // first child, inserted before it
    after = false
  } else if (ref) {
    const refLocation = resolvePanelLocation(workspaceId, ref.id)
    if (refLocation?.kind === 'canvas') destCanvas = refLocation.canvasPanelId
    refForOrder = ref.id
  }
  if (destCanvas && destCanvas === panelId) return false

  const from = resolvePanelLocation(workspaceId, panelId)
  const fromCanvas = from?.kind === 'canvas' ? from.canvasPanelId : null
  const activeBefore = activePanelByStack(dock)

  // --- Move -------------------------------------------------------------------
  if (destCanvas) {
    if (fromCanvas !== destCanvas) {
      prepareTerminalRemount(panelId, panel.type, terminalRegistry)
      if (fromCanvas) ensureCanvasOpsForPanel(fromCanvas).removeNodeForPanel(panelId)
      else dock.getState().undockPanel(panelId)
      ensureCanvasOpsForPanel(destCanvas).addNodeAndFocus(
        panelId, panel.type, undefined, { ...PANEL_CANVAS_DROP_SIZES[panel.type] }, false,
      )
    }
    // Sidebar-only: record the order (the canvas itself is untouched on a reorder).
    const order = placeInOrder(childrenOf(destCanvas).filter((id) => id !== panelId), panelId, refForOrder, after)
    app.setPanelSidebarOrder(workspaceId, destCanvas, order)
  } else {
    // Dock destination: a spot in the reference row's tab stack, or the end.
    const stack = refForOrder
      ? (findStackContainingPanelAcrossZones(dock.getState().zones, refForOrder) as Stack | null)
      : null
    if (fromCanvas) {
      prepareTerminalRemount(panelId, panel.type, terminalRegistry)
      ensureCanvasOpsForPanel(fromCanvas).removeNodeForPanel(panelId)
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

  // The panel left its old canvas: drop it from that canvas's sidebar order.
  if (fromCanvas && fromCanvas !== destCanvas) {
    const old = ws.panels[fromCanvas]?.sidebarOrder
    if (old?.includes(panelId)) app.setPanelSidebarOrder(workspaceId, fromCanvas, old.filter((id) => id !== panelId))
  }
  return true
}
