/** Decode raster artwork and preserve its dimensions while encoding PNG. */
export async function imageUrlToPngBase64(url: string): Promise<string> {
  const bitmap = await createImageBitmap(await fetch(url).then((response) => response.blob()))
  try {
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("Could not create a canvas rendering context.")
    ctx.drawImage(bitmap, 0, 0)
    const dataUrl = canvas.toDataURL("image/png")
    const comma = dataUrl.indexOf(",")
    if (comma < 0) throw new Error("Could not encode the image.")
    return dataUrl.slice(comma + 1)
  } finally {
    bitmap.close()
  }
}

export async function generatedImageToPngDataURL(base64: string): Promise<string> {
  // PNG is already the pipeline's format; avoid decoding and encoding it again.
  if (base64.startsWith("iVBORw0KGgo")) return `data:image/png;base64,${base64}`
  // Let Chromium detect JPEG/WebP from the bytes instead of labeling them PNG.
  const png = await imageUrlToPngBase64(`data:application/octet-stream;base64,${base64}`)
  return `data:image/png;base64,${png}`
}
