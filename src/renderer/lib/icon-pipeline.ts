import { useCallback, useRef, useState } from "react"
import { ipc } from "@/gen/ipc"
import { prepareIcon } from "./prepare-icon"

// ── Types ──────────────────────────────────────────────────────────────────

export type PipelineStatus =
  | "idle"
  | "downloading"
  | "generating"
  | "done"
  | "error"

export interface PipelineProgress {
  /** Overall 0–1 fraction across all active phases. */
  fraction: number
  /** Human-readable message. */
  label: string
}

export interface IconPipeline {
  status: PipelineStatus
  progress: PipelineProgress
  /** Up to 3 finished 1024px PNGs, shared by preview and .icns export. */
  variants: (string | null)[]
  /** Original full-bleed artwork for refinement; never add export styling here. */
  rawVariants: (string | null)[]
  generate: (prompt: string, referenceDataUrl?: string) => void
  cancel: () => void
}

// Reference image normalization.

async function imageUrlToPngBase64(url: string): Promise<string> {
  const bitmap = await createImageBitmap(await fetch(url).then((r) => r.blob()))
  try {
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("Could not create a canvas rendering context.")
    ctx.drawImage(bitmap, 0, 0)
    const dataUrl = canvas.toDataURL("image/png")
    const comma = dataUrl.indexOf(",")
    if (comma < 0) throw new Error("Could not encode the reference image.")
    return dataUrl.slice(comma + 1)
  } finally {
    bitmap.close()
  }
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useIconPipeline(): IconPipeline {
  const [status, setStatus] = useState<PipelineStatus>("idle")
  const [progress, setProgress] = useState<PipelineProgress>({ fraction: 0, label: "" })
  const [variants, setVariants] = useState<(string | null)[]>([null, null, null])
  const [rawVariants, setRawVariants] = useState<(string | null)[]>([null, null, null])

  // Reject stale responses, including when a new generation starts while an
  // earlier request or asynchronous image preparation is still in flight.
  const generationRef = useRef(0)

  const cancel = useCallback(() => {
    generationRef.current += 1
    setStatus("idle")
    setProgress({ fraction: 0, label: "" })
  }, [])

  const generate = useCallback(async (prompt: string, referenceDataUrl?: string) => {
    const generation = ++generationRef.current
    const isCurrent = () => generation === generationRef.current
    setVariants([null, null, null])
    setRawVariants([null, null, null])
    setStatus("generating")
    setProgress({ fraction: 0, label: "" })

    try {
      // Normalize the optional reference image to PNG before sending it.
      const referenceImage = referenceDataUrl ? await imageUrlToPngBase64(referenceDataUrl) : ""
      if (!isCurrent()) return

      const response = await ipc.app.GenerateIcon({
        prompt,
        negativePrompt: "",
        referenceImage,
        seed: 0,
      })

      if (!isCurrent()) return

      if (response.error) {
        setStatus("error")
        setProgress({ fraction: 0, label: `Error: ${response.error}` })
        return
      }

      // Prepare once for both preview and export. Model edits use the original
      // artwork, so margins, masks and shadows never accumulate across edits.
      const newVariants: (string | null)[] = [null, null, null]
      const newRawVariants: (string | null)[] = [null, null, null]
      for (let i = 0; i < Math.min(response.images.length, 3); i++) {
        const raw = `data:image/png;base64,${response.images[i]}`
        newRawVariants[i] = raw
        newVariants[i] = await prepareIcon(raw)
        if (!isCurrent()) return
      }
      setRawVariants(newRawVariants)
      setVariants(newVariants)
      setStatus("done")
      setProgress({ fraction: 1, label: "" })
    } catch (err) {
      if (!isCurrent()) return
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[icon-pipeline] IPC call failed:", err)
      setStatus("error")
      setProgress({ fraction: 0, label: `Error: ${msg}` })
    }
  }, [])

  return { status, progress, variants, rawVariants, generate, cancel }
}
