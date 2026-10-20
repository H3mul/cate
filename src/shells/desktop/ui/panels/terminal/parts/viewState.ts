// What a terminal view keeps of its scroll across an unmount (a hidden tab, a
// layout switch, a culled canvas node). The PTY and its screen live in the
// runtime; the scroll position goes to client state (`panelViews`) and comes
// back when the view mounts again. No React, no xterm.

/** `panelViews` key. */
export const SCROLL_VIEW_KEY = 'terminal.scroll'

interface BufferPosition {
  baseY: number
  viewportY: number
}

/** How far the viewport is above the live bottom; 0 follows the output. Counted
 *  from the bottom because that survives a replay that rebuilds the buffer. */
export function linesFromBottom(buffer: BufferPosition): number {
  return Math.max(0, buffer.baseY - buffer.viewportY)
}

/** The buffer line the viewport top goes to for a saved distance from the
 *  bottom; null when the view stays at the bottom. Clamped to the buffer. */
export function lineToRestore(buffer: Pick<BufferPosition, 'baseY'>, fromBottom: unknown): number | null {
  if (typeof fromBottom !== 'number' || !Number.isFinite(fromBottom) || fromBottom <= 0) return null
  return Math.max(0, buffer.baseY - Math.floor(fromBottom))
}
