// =============================================================================
// useSidebarDnd — drag a panel row to reorder / re-parent it in the sidebar tree.
//
// Native HTML5 drag, like the workspace-list reorder in ProjectList — but each
// row stops its drag events from bubbling so dragging a panel row never drags
// the whole workspace. Drops are applied by lib/workspace/sidebarMove.
// =============================================================================

import React, { useCallback, useState } from 'react'
import type { PanelState } from '../../shared/types'
import { canContain } from '../../shared/panels'
import { canMoveInSidebar, movePanelInSidebar, type SidebarDropZone } from '../lib/workspace/sidebarMove'

/** dataTransfer type that marks a sidebar panel-row drag (workspace drags don't carry it). */
export const SIDEBAR_PANEL_MIME = 'application/x-cate-sidebar-panel'

// The row being dragged. dragover can't read dataTransfer values, so keep it here.
let dragged: { workspaceId: string; panelId: string } | null = null

export interface SidebarRowDnd {
  handlers: Pick<React.HTMLAttributes<HTMLElement>, 'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDrop'>
  hint: SidebarDropZone | null
}

/** Inset line above/below a row, or an outline for "into". */
export function dropIndicatorStyle(hint: SidebarDropZone | null | undefined): React.CSSProperties {
  const color = 'rgba(96, 165, 250, 0.8)'
  if (hint === 'before') return { boxShadow: `inset 0 2px 0 0 ${color}` }
  if (hint === 'after') return { boxShadow: `inset 0 -2px 0 0 ${color}` }
  if (hint === 'into') return { boxShadow: `inset 0 0 0 1.5px ${color}` }
  return {}
}

export function isSidebarPanelDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(SIDEBAR_PANEL_MIME)
}

export function useSidebarDnd(opts: {
  workspaceId: string
  panels: Record<string, PanelState>
  /** The sidebar's current child ids for a canvas, in displayed order. */
  childrenOf: (canvasPanelId: string) => string[]
}) {
  const { workspaceId, panels, childrenOf } = opts
  const [hint, setHint] = useState<{ refId: string | null; zone: SidebarDropZone } | null>(null)

  const active = (e: React.DragEvent): boolean =>
    isSidebarPanelDrag(e) && dragged?.workspaceId === workspaceId

  const zoneFor = useCallback((e: React.DragEvent, row: PanelState): SidebarDropZone => {
    const rect = e.currentTarget.getBoundingClientRect()
    const f = (e.clientY - rect.top) / rect.height
    // A canvas/container row takes drops "into" its middle/bottom; its top quarter is "before".
    if ((row.type === 'canvas' || row.type === 'container') && dragged && canContain(row.type, panels[dragged.panelId]?.type ?? 'editor')) {
      return f < 0.25 ? 'before' : 'into'
    }
    return f < 0.5 ? 'before' : 'after'
  }, [panels])

  const clear = useCallback(() => { dragged = null; setHint(null) }, [])

  const apply = useCallback((refId: string | null, zone: SidebarDropZone) => {
    if (!dragged) return
    const panelId = dragged.panelId
    clear()
    // Apply after the drop handler returns: the move re-parents panels
    // synchronously, and until the handler returns the OS keeps showing the drag ghost.
    setTimeout(() => movePanelInSidebar({ workspaceId, panelId, refId, zone, childrenOf }), 0)
  }, [workspaceId, childrenOf, clear])

  const ws = { panels }
  const rowDnd = useCallback((row: PanelState, draggable = true): SidebarRowDnd => ({
    hint: hint?.refId === row.id ? hint.zone : null,
    handlers: {
      draggable,
      onDragStart: (e) => {
        // Don't let the workspace wrapper (ProjectList) start a workspace drag.
        e.stopPropagation()
        dragged = { workspaceId, panelId: row.id }
        e.dataTransfer.setData(SIDEBAR_PANEL_MIME, row.id)
        e.dataTransfer.effectAllowed = 'move'
      },
      onDragEnd: clear,
      onDragOver: (e) => {
        if (!active(e)) return
        e.stopPropagation()
        const zone = zoneFor(e, row)
        if (!dragged || !canMoveInSidebar(ws, dragged.panelId, row.id, zone, workspaceId)) { setHint(null); return }
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setHint((prev) => (prev?.refId === row.id && prev.zone === zone ? prev : { refId: row.id, zone }))
      },
      onDrop: (e) => {
        if (!active(e)) return
        e.preventDefault()
        e.stopPropagation()
        apply(row.id, zoneFor(e, row))
      },
    },
  }), [hint, workspaceId, panels, clear, zoneFor, apply])

  /** Drop target after the last top-level row ("end of list"). */
  const endDnd: SidebarRowDnd = {
    hint: hint?.refId === null ? 'before' : null,
    handlers: {
      onDragOver: (e) => {
        if (!active(e)) return
        e.stopPropagation()
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setHint((prev) => (prev?.refId === null ? prev : { refId: null, zone: 'before' }))
      },
      onDrop: (e) => {
        if (!active(e)) return
        e.preventDefault()
        e.stopPropagation()
        apply(null, 'before')
      },
    },
  }

  return { rowDnd, endDnd }
}
