import { useCallback, useRef, useState } from "react"
import { ipc } from "@/gen/ipc"
import { prepareIcon } from "./prepare-icon"
import { generatedImageToPngDataURL, imageUrlToPngBase64 } from "./image-normalization"

type PendingHistory = { generationId: string; prompt: string; parentId: string; raw: (string | null)[]; prepared: (string | null)[] }

async function thumbnail(src: string) {
  const bitmap = await createImageBitmap(await (await fetch(src)).blob())
  try {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 128
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Could not prepare a history thumbnail.")
    context.drawImage(bitmap, 0, 0, 128, 128)
    return canvas.toDataURL("image/png")
  } finally { bitmap.close() }
}

// ── Types ──────────────────────────────────────────────────────────────────

export type PipelineStatus =
  | "idle"
  | "downloading"
  | "generating"
  | "saving"
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
  historyIds: string[]
  historyError: string
  historyRevision: number
  retryingHistory: boolean
  retryHistory: () => Promise<void>
  generate: (prompt: string, referenceDataUrl?: string, parentId?: string) => void
  cancel: () => void
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useIconPipeline(): IconPipeline {
  const [status, setStatus] = useState<PipelineStatus>("idle")
  const [progress, setProgress] = useState<PipelineProgress>({ fraction: 0, label: "" })
  const [variants, setVariants] = useState<(string | null)[]>([null, null, null])
  const [rawVariants, setRawVariants] = useState<(string | null)[]>([null, null, null])
  const [historyIds, setHistoryIds] = useState<string[]>([])
  const [historyError, setHistoryError] = useState("")
  const [historyRevision, setHistoryRevision] = useState(0)
  const [retryingHistory, setRetryingHistory] = useState(false)
  const pendingHistory = useRef<PendingHistory | null>(null)

  const keepHistory = useCallback(async (pending: PendingHistory) => {
    try {
      const variants = []
      for (let i = 0; i < pending.prepared.length; i++) {
        const rawPng = pending.raw[i], preparedPng = pending.prepared[i]
        if (rawPng && preparedPng) variants.push({ variantIndex: i, rawPng, preparedPng, thumbnailPng: await thumbnail(preparedPng) })
      }
      const saved = await ipc.app.RecordIconHistory({ generationId: pending.generationId, prompt: pending.prompt, parentId: pending.parentId, variants })
      const ids = ["", "", ""]
      for (const entry of saved.entries) ids[entry.variantIndex] = entry.id
      setHistoryIds(ids)
      setHistoryError("")
      setHistoryRevision(value => value + 1)
      pendingHistory.current = null
    } catch {
      setHistoryError("These variants couldn’t be kept in History. Try again before starting another generation.")
      void ipc.app.SetUnsavedIconState({ unsaved: true }).catch(() => {})
    }
  }, [])

  const retryHistory = useCallback(async () => {
    if (!pendingHistory.current) return
    setRetryingHistory(true)
    try { await keepHistory(pendingHistory.current) }
    finally { setRetryingHistory(false) }
  }, [keepHistory])

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
    // Starting another generation is blocked until the previous set is archived.
    // Canceling this in-flight set therefore leaves only safely stored artwork.
    void ipc.app.SetUnsavedIconState({ unsaved: false }).catch(() => {})
  }, [])

  const generate = useCallback(async (prompt: string, referenceDataUrl?: string, parentId = "") => {
    if (pendingHistory.current) return
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
      setHistoryIds([])
      const pending = { generationId: requestId, prompt, parentId, raw: newRawVariants, prepared: newVariants }
      pendingHistory.current = pending
      setStatus("saving")
      setProgress({ fraction: 1, label: "Keeping icons in History…" })
      await keepHistory(pending)
      setStatus("done")
      setProgress({ fraction: 1, label: "" })
    } catch (err) {
      if (!isCurrent()) return
      requestRef.current = null
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[icon-pipeline] IPC call failed:", err)
      setStatus("error")
      setProgress({ fraction: 0, label: `Error: ${msg}` })
      void ipc.app.SetUnsavedIconState({ unsaved: false }).catch(() => {})
    }
  }, [keepHistory])

  return { status, progress, variants, rawVariants, generate, cancel, historyIds, historyError, historyRevision, retryHistory, retryingHistory }
}
