import { useCallback, useEffect, useRef, useState } from "react"
import { Download } from "lucide-react"
import { MacOSIcon } from "@/components/macos-icon"
import { PromptInput, type PrimaryAction } from "@/components/prompt-input"
import { GenerationSettings } from "@/components/generation-settings"
import { ErrorModal, generationErrorSuggestsApiKeyIssue } from "@/components/error-modal"
import { SaveSuccessModal } from "@/components/save-success-modal"
import { SquircleClipDefs } from "@/components/squircle-clip-defs"
import { TitleBarStatus } from "@/components/title-bar-status"
import type { IconState } from "@/components/icon-types"
import { useIconPipeline } from "@/lib/icon-pipeline"
import { ipc } from "@/gen/ipc"
import { cn } from "@/lib/utils"

type ResumeAfterCancel = "idle" | "generated" | "refine"

export function AppContent() {
  const [iconState, setIconState] = useState<IconState>("idle")
  const [prompt, setPrompt] = useState("")
  const [attachments, setAttachments] = useState<string[]>([])
  const [selectedVariant, setSelectedVariant] = useState<number | null>(null)
  const [baseIconSrc, setBaseIconSrc] = useState<string | null>(null)
  // Original artwork for model edits; baseIconSrc is the finished export PNG.
  const [rawBaseIconSrc, setRawBaseIconSrc] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<{ folderPath: string; icnsPath: string } | null>(
    null
  )
  const [iconDirty, setIconDirty] = useState(false)
  const [keyReady, setKeyReady] = useState<boolean | null>(null)
  const [keyRequest, setKeyRequest] = useState(0)
  const resumeAfterCancelRef = useRef<ResumeAfterCancel>("idle")

  const pipeline = useIconPipeline()
  const prevPipelineStatusRef = useRef(pipeline.status)

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      for (const url of prev) URL.revokeObjectURL(url)
      return []
    })
  }, [])

  // Sync iconState with pipeline status changes.
  useEffect(() => {
    if (pipeline.status === "done") {
      const hasAny = pipeline.variants.some((v) => v !== null)
      setIconState(hasAny ? "generated" : "idle")
    } else if (pipeline.status === "error") {
      // Restore the icon display to what it was before generation started.
      setIconState(resumeAfterCancelRef.current)
      // Surface the error in a modal. Strip the "Error: " prefix added by the pipeline.
      const raw = pipeline.progress.label
      setErrorMessage(raw.startsWith("Error: ") ? raw.slice(7) : raw)
    }
  }, [pipeline.status]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const was = prevPipelineStatusRef.current
    prevPipelineStatusRef.current = pipeline.status
    if (pipeline.status !== "done") return
    if (!pipeline.variants.some((v) => v !== null)) return
    if (was !== "done") {
      setIconDirty(true)
    }
  }, [pipeline.status, pipeline.variants])

  useEffect(() => {
    ipc.app.SetUnsavedIconState({ unsaved: iconDirty }).catch(() => {})
  }, [iconDirty])

  const startGeneration = () => {
    if (!prompt.trim() || iconState === "generating") return
    if (!keyReady) {
      setKeyRequest((request) => request + 1)
      return
    }
    resumeAfterCancelRef.current =
      iconState === "refine" ? "refine" : iconState === "generated" ? "generated" : "idle"
    setSelectedVariant(null)
    setIconState("generating")
    // In refine mode the confirmed variant is the reference; otherwise use the
    // user-attached image (if any).
    const referenceImage = iconState === "refine" ? (rawBaseIconSrc ?? attachments[0]) : attachments[0]
    pipeline.generate(prompt, referenceImage)
  }

  const stopGeneration = () => {
    pipeline.cancel()
    setIconState(resumeAfterCancelRef.current)
  }

  const confirmSelectedVariant = () => {
    if (iconState !== "generated" || selectedVariant === null) return
    setIconDirty(true)
    setBaseIconSrc(pipeline.variants[selectedVariant])
    setRawBaseIconSrc(pipeline.rawVariants[selectedVariant])
    setIconState("refine")
    setSelectedVariant(null)
    setPrompt("")
    clearAttachments()
  }

  const handleSave = async () => {
    // Export exactly the prepared PNG shown in the preview, including alpha,
    // inset and shadow. No reliance on an OS-provided mask in Finder or DMG.
    const preparedSrc =
      iconState === "refine"
        ? baseIconSrc
        : selectedVariant !== null
          ? pipeline.variants[selectedVariant]
          : null
    if (!preparedSrc) return

    try {
      // Fetch the object URL and convert to Uint8Array for IPC transfer.
      const response = await fetch(preparedSrc)
      const buffer = await response.arrayBuffer()
      const imageData = new Uint8Array(buffer)
      const saved = await ipc.app.SaveIcon({ imageData })
      if (!saved.canceled && saved.icnsPath) {
        setIconDirty(false)
        setSaveSuccess({ folderPath: saved.savedPath, icnsPath: saved.icnsPath })
      }
    } catch {
      // Silently ignore IPC errors.
    }
  }

  const inputPlaceholder =
    iconState === "refine"
      ? "Make changes to the icon or describe a new idea…"
      : "Describe your app icon…"

  const primaryAction: PrimaryAction =
    iconState === "generating"
      ? "stop"
      : iconState === "generated" && selectedVariant !== null
        ? "select"
        : iconState === "generated" && selectedVariant === null
          ? "refresh"
          : "submit"

  const primaryEnabled =
    iconState === "generating"
      ? true
      : primaryAction === "select"
        ? selectedVariant !== null
        : primaryAction === "refresh" || primaryAction === "submit"
          ? keyReady !== null && prompt.trim().length > 0
          : false

  const onPrimary = () => {
    if (primaryAction === "stop") {
      stopGeneration()
      return
    }
    if (primaryAction === "select") {
      confirmSelectedVariant()
      return
    }
    startGeneration()
  }

  const canSave = iconState === "refine" && baseIconSrc != null

  const showStatus =
    pipeline.status === "downloading" && pipeline.progress.label !== ""

  return (
    <div className="dark flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <SquircleClipDefs />

      {errorMessage && (
        <ErrorModal
          message={errorMessage}
          onClose={() => setErrorMessage(null)}
          onUpdateApiKey={
            generationErrorSuggestsApiKeyIssue(errorMessage)
              ? () => {
                  setErrorMessage(null)
                  setKeyRequest((request) => request + 1)
                }
              : undefined
          }
        />
      )}

      {saveSuccess && (
        <SaveSuccessModal
          folderPath={saveSuccess.folderPath}
          icnsPath={saveSuccess.icnsPath}
          onClose={() => setSaveSuccess(null)}
        />
      )}

      {/* macOS traffic-light spacer (also serves as the drag region). */}
      <div className="draggable" />

      {/* Compact title-bar status: progress line + label. */}
      {showStatus && (
        <TitleBarStatus
          label={pipeline.progress.label}
          fraction={pipeline.progress.fraction}
          isError={pipeline.status === "error"}
        />
      )}

      {/* Save button — top right corner. */}
      <div className="absolute top-3 right-3 z-50">
        <button
          disabled={!canSave}
          onClick={handleSave}
          className={cn(
            "flex items-center gap-2 px-4 h-8 rounded-lg text-sm font-medium transition-all duration-200 non-draggable",
            canSave
              ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.97] shadow-md"
              : "bg-secondary/30 text-muted-foreground/40 cursor-not-allowed"
          )}
        >
          <Download className="w-3.5 h-3.5" />
          Save
        </button>
      </div>

      {/* Icon preview — pinned to top, centered horizontally. */}
      <div className="flex justify-center pt-28 pb-20 px-10">
        <MacOSIcon
          state={iconState}
          selected={selectedVariant}
          onSelect={setSelectedVariant}
          variants={pipeline.variants}
          baseIconSrc={baseIconSrc}
        />
      </div>

      {/* Bottom area — input, pushed to the bottom. */}
      <div className="flex flex-1 flex-col items-center justify-end gap-6 px-4 pb-4">
        <PromptInput
          value={prompt}
          onChange={setPrompt}
          primaryAction={primaryAction}
          onPrimary={onPrimary}
          primaryEnabled={primaryEnabled}
          onRegenerate={primaryAction === "select" ? startGeneration : undefined}
          regenerateEnabled={prompt.trim().length > 0}
          inputDisabled={iconState === "generating"}
          placeholder={inputPlaceholder}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          settingsControl={<GenerationSettings
            disabled={iconState === "generating"}
            keyRequest={keyRequest}
            onKeyReadyChange={setKeyReady}
          />}
        />
      </div>
    </div>
  )
}
