/** Place an existing overlay inside its visible coordinate space. */
export function placeOverlay(x: number, y: number, width: number, height: number, availableWidth: number, availableHeight: number) {
  return {
    left: Math.max(8, Math.min(x, availableWidth - width - 8)),
    top: Math.max(8, Math.min(y, availableHeight - height - 8)),
  }
}
