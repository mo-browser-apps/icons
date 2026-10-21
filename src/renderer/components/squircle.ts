import type { CSSProperties } from "react"

// Decorative shape for the idle/loading stack only. Generated icons and their
// selection outline use the Sequoia geometry in lib/icon-geometry.ts.
const SQUIRCLE_N = 3.2
const SQUICLE_STEPS = 72

function buildSquirclePoints(
  cx: number,
  cy: number,
  a: number,
  b: number,
  n: number,
  steps: number
) {
  const p = 2 / n
  const pts: { x: number; y: number }[] = []
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    const c = Math.cos(t)
    const s = Math.sin(t)
    const x = cx + a * Math.sign(c) * Math.pow(Math.abs(c), p)
    const y = cy + b * Math.sign(s) * Math.pow(Math.abs(s), p)
    pts.push({ x, y })
  }
  return pts
}

function pointsToPathD(pts: { x: number; y: number }[]) {
  return (
    pts
      .map((q, i) => `${i === 0 ? "M" : "L"} ${q.x} ${q.y}`)
      .join(" ") + " Z"
  )
}

const _SQU01 = buildSquirclePoints(0.5, 0.5, 0.5, 0.5, SQUIRCLE_N, SQUICLE_STEPS)
export const SQUICLE_PATH_01 = pointsToPathD(_SQU01)
export const SQUICLE_PATH_100 = pointsToPathD(
  _SQU01.map((q) => ({ x: q.x * 100, y: q.y * 100 }))
)
const _BP = buildSquirclePoints(72, 72, 54, 54, SQUIRCLE_N, SQUICLE_STEPS)
export const BLUEPRINT_SQUICLE_D = pointsToPathD(_BP)

export const ICON_CLIP_FILTER_BASE = "drop-shadow(0 12px 24px rgba(0,0,0,0.5))"

export const appIconShapeClip: CSSProperties = { clipPath: "url(#moicons-squircle-clip)" }

export const ICON_FACE_EDGE_DEFAULT = "rgba(255,255,255,0.08)"
/** Dark gray rim for the idle / generating three-icon stack. */
export const ICON_STACK_EDGE = "rgba(54, 54, 60, 0.9)"
export const ICON_STACK_EDGE_PX = 4

/** viewBox 0–100 stroke width so the half-stroke that remains inside the clip reads as `visibleBorderPx`. */
export function squircleStrokeWidthVbForVisibleBorder(visibleBorderPx: number, boxSizePx: number): string {
  return String((2 * visibleBorderPx * 100) / boxSizePx)
}
