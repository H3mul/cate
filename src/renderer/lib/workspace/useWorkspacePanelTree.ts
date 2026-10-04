// =============================================================================
// useWorkspacePanelTree — the single source of truth for "what panels does this
// workspace contain, and where do they live". Reads the workspace panel registry
// (ws.panels) and joins it against EVERY canvas store's nodes plus the dock
// store, so the result is multi-canvas- and dock-aware and excludes ghosts
// (records placed nowhere) and panels detached into other windows.
//
// Both the sidebar workspace overview (WorkspaceTab) and the Cmd+K command
// palette consume this, so the two can never disagree about which panels exist
// or where they are.
// =============================================================================

import { useMemo, useState, useCallback, useEffect, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/shallow'
import type { PanelState } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { getOrCreateCanvasStoreForPanel } from '../../stores/canvasStore'
import {
  getCanvasSnapshotForPanel,
  getNodeDockLayout,
  getWorkspaceCanvasPanelIds,
  getWorkspaceDockSnapshot,
} from './canvasAccess'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { getWorkspaceDockStore } from './dockRegistry'
import { flattenDockOrder, sortByOrder } from './sidebarOrder'
import { partitionWorkspacePanels, buildColdStartCanvasChildOwners } from '../../sidebar/partitionWorkspacePanels'
import { sortWorkspacePanels } from '../../sidebar/sortWorkspacePanels'

const EMPTY_PANELS: Record<string, PanelState> = {}

export interface WorkspacePanelTree {
  /** The raw workspace panel registry (ws.panels). */
  panels: Record<string, PanelState>
  /** All panels, sorted by type then title. */
  panelList: PanelState[]
  /** Top-level parent panels (canvases and containers), in order. */
  canvasPanels: PanelState[]
  /** Children grouped by the canvas panel id that hosts them. */
  childrenByCanvas: Record<string, PanelState[]>
  /** Canvas children whose owning canvas is gone and no canvas remains. */
  orphanCanvasChildren: PanelState[]
  /** Docked panels that sit beside the canvases. */
  freePanels: PanelState[]
  /** Canvases and free panels interleaved in dock tab order — the sidebar's
   *  top-level rows. Children come from childrenByCanvas. */
  topLevelPanels: PanelState[]
  /** Flat list in the overview's render order, ghosts/detached excluded. */
  orderedPanels: PanelState[]
}

// Subscribe to every canvas store in a workspace and return a map of
// canvas-child panel id -> the canvas panel id that hosts it. A workspace can
// host multiple canvas panels, so we scan ALL canvas panels in the workspace.
// We record WHICH canvas owns each child (not merely THAT it lives
// on some canvas), so each child nests under its own canvas instead of
// collapsing them all under the first one.
function useWorkspaceCanvasChildOwners(workspaceId: string): Map<string, string> {
  const canvasPanelIds = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return [] as string[]
    return Object.values(ws.panels)
      .filter((p) => p.type === 'canvas')
      .map((p) => p.id)
  }))

  const stores = useMemo(
    () => canvasPanelIds.map((id) => getOrCreateCanvasStoreForPanel(id)),
    [canvasPanelIds],
  )

  const compute = useCallback(() => {
    const owners = new Map<string, string>()
    for (let i = 0; i < stores.length; i++) {
      const canvasPanelId = canvasPanelIds[i]
      for (const node of Object.values(stores[i].getState().nodes)) {
        // Each canvas node has its own mini-dock layout; a node may host several
        // tabbed panels. Walk the full layout so every tab classifies as a child
        // of this canvas. Read the
        // LIVE per-node DockStore (the runtime authority).
        for (const id of collectPanelIds(getNodeDockLayout(canvasPanelId, node.id))) {
          owners.set(id, canvasPanelId)
        }
      }
    }
    return owners
  }, [stores, canvasPanelIds])

  const [owners, setOwners] = useState<Map<string, string>>(compute)

  useEffect(() => {
    // Recompute immediately on store-set change so we don't render one frame of
    // stale ids after switching workspaces.
    setOwners(compute())
    const unsubs = stores.map((s) => s.subscribe(() => setOwners(compute())))
    return () => {
      for (const fn of unsubs) fn()
    }
  }, [stores, compute])

  return owners
}

// Dock-placed panel ids in tab order (null = placement unknown, cold start).
// Subscribes to the workspace's live dock store so a tab reorder in the dock
// re-orders the sidebar. The snapshot is a joined string so React compares it
// by value.
function useDockOrder(workspaceId: string): string[] | null {
  const store = getWorkspaceDockStore(workspaceId)
  const subscribe = useCallback((notify: () => void) => (store ? store.subscribe(notify) : () => {}), [store])
  const key = useSyncExternalStore(subscribe, () => {
    const snapshot = getWorkspaceDockSnapshot(workspaceId)
    return snapshot ? flattenDockOrder(snapshot.zones).join('\0') : null
  })
  return useMemo(() => (key === null ? null : key === '' ? [] : key.split('\0')), [key])
}

export function useWorkspacePanelTree(workspaceId: string): WorkspacePanelTree {
  const panels = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws?.panels ?? EMPTY_PANELS
  }))

  // Worktrees + rootPath drive the per-worktree grouping below. Read separately
  // (and shallow) so a recolor/add doesn't churn the whole tree, only the order.
  const { worktrees, rootPath } = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return { worktrees: ws?.worktrees, rootPath: ws?.rootPath }
  }))

  // Panel list grouped by worktree first (so a worktree's terminals/agents stay
  // together), then by type (canvas, terminal, editor, browser, …), then title.
  const panelList = useMemo(
    () => sortWorkspacePanels(Object.values(panels), worktrees, rootPath),
    [panels, worktrees, rootPath],
  )

  // Set of panel ids living on this workspace's canvases. The reactive hook
  // covers every live canvas store; the resolver fills the cold-start gap for a
  // workspace whose canvas was never mounted (its persisted projection).
  const liveCanvasChildOwners = useWorkspaceCanvasChildOwners(workspaceId)
  const canvasChildOwners = useMemo(() => {
    const owners = new Map<string, string>(liveCanvasChildOwners)
    const coldOwners = buildColdStartCanvasChildOwners(
      getWorkspaceCanvasPanelIds(workspaceId).map((canvasPanelId) => ({
        canvasPanelId,
        nodes: Object.values(getCanvasSnapshotForPanel(canvasPanelId)?.nodes ?? {}),
      })),
    )
    for (const [id, owner] of coldOwners) if (!owners.has(id)) owners.set(id, owner)
    // Container children live in the container's mirrored layout (panel record).
    for (const p of Object.values(panels)) {
      if (p.type === 'container') for (const id of collectPanelIds(p.containerLayout)) owners.set(id, p.id)
    }
    return owners
  }, [liveCanvasChildOwners, workspaceId, panels])

  // The dock-placed id set lets partitioning drop ghosts — panels still in
  // ws.panels but referenced by no canvas or dock. Read live (snapshot
  // resolver); null = unknown (cold start), in which case nothing is filtered so
  // a real panel is never hidden. Read inline (not memoized) so a dock move that
  // re-renders via the canvas-owners subscription re-reads the latest placement.
  const dockOrder = useDockOrder(workspaceId)
  const dockPlacedIds = dockOrder ? new Set(dockOrder) : null
  const partition = partitionWorkspacePanels(panelList, canvasChildOwners, dockPlacedIds)
  const { canvasPanels, orphanCanvasChildren, freePanels } = partition

  // A container's children follow its layout (tab/split order — the same order
  // as its tab tokens); a canvas's follow its sidebar-only order list.
  const childrenByCanvas: Record<string, PanelState[]> = {}
  for (const [parentId, children] of Object.entries(partition.childrenByCanvas)) {
    const parent = panels[parentId]
    childrenByCanvas[parentId] = sortByOrder(
      children,
      parent?.type === 'container' ? collectPanelIds(parent.containerLayout) : parent?.sidebarOrder,
    )
  }

  // Top-level rows follow the dock's tab order.
  const rank = new Map((dockOrder ?? []).map((id, index) => [id, index]))
  const topLevelPanels = [...canvasPanels, ...freePanels]
    .map((panel, index) => ({ panel, index }))
    .sort((a, b) => (rank.get(a.panel.id) ?? Infinity) - (rank.get(b.panel.id) ?? Infinity) || a.index - b.index)
    .map(({ panel }) => panel)

  // Flatten to the overview's render order: each top-level row followed by its
  // (recursively nested) children, then orphaned canvas children.
  const orderedPanels: PanelState[] = []
  const pushWithChildren = (parent: PanelState): void => {
    orderedPanels.push(parent)
    for (const child of childrenByCanvas[parent.id] ?? []) pushWithChildren(child)
  }
  for (const panel of topLevelPanels) pushWithChildren(panel)
  orderedPanels.push(...orphanCanvasChildren)

  return { panels, panelList, canvasPanels, childrenByCanvas, orphanCanvasChildren, freePanels, topLevelPanels, orderedPanels }
}
