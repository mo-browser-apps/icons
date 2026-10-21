import { ICON_BODY_SIZE, ICON_INSET, ICON_SIZE, MACOS_ICON_PATH } from "./icon-geometry"

/**
 * Turn full-bleed artwork into the final macOS 15 PNG. The same PNG is used
 * for preview and export; always keep the original artwork for model edits.
 */
export async function prepareIcon(dataUrl: string): Promise<string> {
  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error("Could not load the icon artwork.")
  const bitmap = await createImageBitmap(await response.blob())
  try {
    // Render the outline at 2x, then downsample for smooth alpha edges.
    const scale = 2
    const artwork = document.createElement("canvas")
    artwork.width = artwork.height = ICON_SIZE * scale
    const art = artwork.getContext("2d")
    if (!art) throw new Error("Could not create an icon rendering context.")
    art.scale(scale, scale)
    art.imageSmoothingQuality = "high"
    art.clip(new Path2D(MACOS_ICON_PATH))

    // Providers are asked for a square. Center-crop an unexpected aspect ratio
    // instead of stretching the subject. Scale the entire square into the body.
    const side = Math.min(bitmap.width, bitmap.height)
    art.drawImage(
      bitmap,
      (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
      ICON_INSET, ICON_INSET, ICON_BODY_SIZE, ICON_BODY_SIZE,
    )

    const composite = document.createElement("canvas")
    composite.width = composite.height = artwork.width
    const ctx = composite.getContext("2d")
    if (!ctx) throw new Error("Could not create an icon rendering context.")
    // App styling, in master-image pixels. Shadows are drawn outside the mask;
    // the 100px inset leaves room for their full falloff on every side.
    ctx.shadowColor = "rgba(0, 0, 0, 0.24)"
    ctx.shadowBlur = 24 * scale
    ctx.shadowOffsetY = 12 * scale
    ctx.drawImage(artwork, 0, 0)

    const output = document.createElement("canvas")
    output.width = output.height = ICON_SIZE
    const final = output.getContext("2d")
    if (!final) throw new Error("Could not create an icon rendering context.")
    final.imageSmoothingQuality = "high"
    final.drawImage(composite, 0, 0, ICON_SIZE, ICON_SIZE)
    return output.toDataURL("image/png")
  } finally {
    bitmap.close()
  }
}
