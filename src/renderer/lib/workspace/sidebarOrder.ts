// =============================================================================
// sidebarOrder — pure ordering helpers for the sidebar's panel tree.
//
// Every list follows the real tab order (so reordering rows reorders the tab
// tokens, and vice versa): the dock's tabs at the top level, a container's
// layout, and a canvas's windows (creation order, tab order within each).
// =============================================================================

import type { DockLayoutNode, WindowDockState } from '../../../shared/types'
import { collectPanelIds } from '../../../shared/collectPanelIds'

/** Zones in the order the sidebar lists them: the main (center) zone first. */
export const SIDEBAR_ZONE_ORDER = ['center', 'left', 'right', 'bottom'] as const

/** Every dock-placed panel id, in tab order, zone by zone. */
export function flattenDockOrder(zones: WindowDockState): string[] {
  return SIDEBAR_ZONE_ORDER.flatMap((zone) => collectPanelIds(zones[zone].layout))
}

/** panelId -> id of the tab stack holding it, for every panel in a layout. A
 *  container's split tree is shown as a flat list; consecutive members in
 *  different stacks are separated by a split separator. */
export function stackIdByPanel(layout: DockLayoutNode | null | undefined, out: Record<string, string> = {}): Record<string, string> {
  if (!layout) return out
  if (layout.type === 'tabs') for (const id of layout.panelIds) out[id] = layout.id
  else for (const child of layout.children) stackIdByPanel(child, out)
  return out
}

/** A canvas's windows (nodes) in creation order, each a group of tabs: the
 *  children's order (window by window, tab order within) and child -> window id. */
export function canvasNodeGroups(
  nodes: Array<{ id: string; creationIndex?: number; dockLayout: DockLayoutNode | null }>,
): { order: string[]; nodeOf: Record<string, string> } {
  const order: string[] = []
  const nodeOf: Record<string, string> = {}
  const sorted = nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => (a.node.creationIndex ?? a.index) - (b.node.creationIndex ?? b.index))
  for (const { node } of sorted) {
    for (const id of collectPanelIds(node.dockLayout)) {
      order.push(id)
      nodeOf[id] = node.id
    }
  }
  return { order, nodeOf }
}

/** Stable sort by position in `order`; ids absent from it keep their relative
 *  order after the listed ones. */
export function sortByOrder<T extends { id: string }>(items: T[], order: readonly string[] | undefined): T[] {
  if (!order || order.length === 0) return items
  const rank = new Map(order.map((id, index) => [id, index]))
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (rank.get(a.item.id) ?? Infinity) - (rank.get(b.item.id) ?? Infinity) || a.index - b.index)
    .map(({ item }) => item)
}
