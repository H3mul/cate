// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

const movePanelInSidebar = vi.hoisted(() => vi.fn(() => true))
vi.mock('../lib/workspace/sidebarMove', () => ({
  movePanelInSidebar,
  canMoveInSidebar: () => true,
}))

import { SIDEBAR_PANEL_MIME, useSidebarDnd } from './useSidebarDnd'
import type { PanelState } from '../../shared/types'

const panels = {
  a: { id: 'a', type: 'terminal', title: 'A', isDirty: false },
  b: { id: 'b', type: 'editor', title: 'B', isDirty: false },
} as unknown as Record<string, PanelState>

const outerDragStart = vi.fn()
const outerDragOver = vi.fn()

function Harness() {
  const { rowDnd } = useSidebarDnd({ workspaceId: 'ws', panels, childrenOf: () => [] })
  return (
    <div onDragStart={outerDragStart} onDragOver={outerDragOver}>
      <button id="a" {...rowDnd(panels.a).handlers} />
      <button id="b" {...rowDnd(panels.b).handlers} />
    </div>
  )
}

function dragEvent(type: string, data: Record<string, string> = {}, clientY = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown; clientY: number }
  const types = Object.keys(data)
  event.dataTransfer = { types, setData: (k: string, v: string) => { data[k] = v; types.push(k) }, getData: (k: string) => data[k], effectAllowed: '', dropEffect: '' }
  event.clientY = clientY
  return event
}

let root: ReturnType<typeof createRoot> | null = null
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = '' })

it('dragging a row does not bubble to the workspace wrapper, and dropping moves the panel (after the handler returns)', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<Harness />))

  const a = host.querySelector('#a')!
  const b = host.querySelector('#b')!
  const data: Record<string, string> = {}
  act(() => { a.dispatchEvent(dragEvent('dragstart', data)) })
  expect(data[SIDEBAR_PANEL_MIME]).toBe('a')
  expect(outerDragStart).not.toHaveBeenCalled()

  // jsdom rects are 0x0, so clientY=0 lands in the "before" half.
  act(() => { b.dispatchEvent(dragEvent('dragover', { [SIDEBAR_PANEL_MIME]: 'a' })) })
  expect(outerDragOver).not.toHaveBeenCalled()
  act(() => { b.dispatchEvent(dragEvent('drop', { [SIDEBAR_PANEL_MIME]: 'a' })) })
  expect(movePanelInSidebar).not.toHaveBeenCalled() // deferred so the OS drag ghost clears first
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  expect(movePanelInSidebar).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws', panelId: 'a', refId: 'b' }))
})
