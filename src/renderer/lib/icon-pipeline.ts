import { useCallback, useRef, useState } from "react"
import { ipc } from "@/gen/ipc"
import { prepareIcon } from "./prepare-icon"
import { generatedImageToPngDataURL, imageUrlToPngBase64 } from "./image-normalization"

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

// ── Hook ───────────────────────────────────────────────────────────────────

export function useIconPipeline(): IconPipeline {
  const [status, setStatus] = useState<PipelineStatus>("idle")
  const [progress, setProgress] = useState<PipelineProgress>({ fraction: 0, label: "" })
  const [variants, setVariants] = useState<(string | null)[]>([null, null, null])
  const [rawVariants, setRawVariants] = useState<(string | null)[]>([null, null, null])

  // Reject stale responses, including when a new generation starts while an
  // earlier request or asynchronous image preparation is still in flight.
  const generationRef = useRef(0)
  const requestRef = useRef<string | null>(null)

  const cancel = useCallback(() => {
    if (requestRef.current) void ipc.app.CancelGeneration({ requestId: requestRef.current }).catch(() => {})
    requestRef.current = null
    generationRef.current += 1
    setStatus("idle")
    setProgress({ fraction: 0, label: "" })
  }, [])

  const generate = useCallback(async (prompt: string, referenceDataUrl?: string) => {
    const generation = ++generationRef.current
    const isCurrent = () => generation === generationRef.current
    // Keep the last completed set until its replacement is ready. Stop, provider
    // errors and image decoding failures must not destroy the user's work.
    setStatus("generating")
    setProgress({ fraction: 0, label: "" })

    try {
      // Normalize the optional reference image to PNG before sending it.
      const referenceImage = referenceDataUrl ? await imageUrlToPngBase64(referenceDataUrl) : ""
      if (!isCurrent()) return

      const requestId = crypto.randomUUID()
      requestRef.current = requestId
      const response = await ipc.app.GenerateIcon({
        requestId,
        prompt,
        negativePrompt: "",
        referenceImage,
        seed: 0,
      })

      if (!isCurrent()) return
      requestRef.current = null

      if (response.error) {
        setStatus("error")
        setProgress({ fraction: 0, label: `Error: ${response.error}` })
        return
      }

      // Prepare once for both preview and export. Model edits use the original
      // artwork, so margins, masks and shadows never accumulate across edits.
      const newVariants: (string | null)[] = [null, null, null]
      const newRawVariants: (string | null)[] = [null, null, null]
      let preparationError: unknown
      for (let i = 0; i < Math.min(response.images.length, 3); i++) {
        try {
          const raw = await generatedImageToPngDataURL(response.images[i])
          if (!isCurrent()) return
          const prepared = await prepareIcon(raw)
          newRawVariants[i] = raw
          newVariants[i] = prepared
        } catch (error) {
          preparationError = error
        }
        if (!isCurrent()) return
      }
      if (!newVariants.some(Boolean)) {
        throw preparationError ?? new Error("No usable images were returned. Please try again.")
      }
      setRawVariants(newRawVariants)
      setVariants(newVariants)
      setStatus("done")
      setProgress({ fraction: 1, label: "" })
    } catch (err) {
      if (!isCurrent()) return
      requestRef.current = null
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[icon-pipeline] IPC call failed:", err)
      setStatus("error")
      setProgress({ fraction: 0, label: `Error: ${msg}` })
    }
  }, [])

  return { status, progress, variants, rawVariants, generate, cancel }
}
