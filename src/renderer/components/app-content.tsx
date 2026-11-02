import { useEffect, useRef, useState } from "react"
import { Download, History } from "lucide-react"
import { IconHistory } from "@/components/icon-history"
import type { GetIconHistoryResponse } from "@/gen/app"
import { MacOSIcon } from "@/components/macos-icon"
import { PromptInput, type PrimaryAction } from "@/components/prompt-input"
import { GenerationSettings } from "@/components/generation-settings"
import { ErrorModal, generationErrorSuggestsConnectionIssue } from "@/components/error-modal"
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
  const [attachment, setAttachment] = useState<string | null>(null)
  const [attachmentLoading, setAttachmentLoading] = useState(false)
  const [selectedVariant, setSelectedVariant] = useState<number | null>(null)
  const [baseIconSrc, setBaseIconSrc] = useState<string | null>(null)
  // Original artwork for model edits; baseIconSrc is the finished export PNG.
  const [rawBaseIconSrc, setRawBaseIconSrc] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorTitle, setErrorTitle] = useState("Generation failed")
  const [saveSuccess, setSaveSuccess] = useState<{ folderPath: string; icnsPath: string } | null>(
    null
  )
  const [historyOpen, setHistoryOpen] = useState(false)
  const [baseHistoryId, setBaseHistoryId] = useState("")
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const [historyRevision, setHistoryRevision] = useState(0)
  const [savingExport, setSavingExport] = useState(false)
  const [connectionReady, setConnectionReady] = useState<boolean | null>(null)
  const [connectionRequest, setConnectionRequest] = useState(0)
  const resumeAfterCancelRef = useRef<ResumeAfterCancel>("idle")
  const unarchivedSelection = useRef<number | null>(null)

  const pipeline = useIconPipeline()

  useEffect(() => {
    const selected = unarchivedSelection.current
    if (selected !== null && pipeline.historyIds[selected]) {
      setBaseHistoryId(pipeline.historyIds[selected])
      unarchivedSelection.current = null
    }
  }, [pipeline.historyIds])

  // Sync iconState with pipeline status changes.
  useEffect(() => {
    if (pipeline.status === "done") {
      setSelectedVariant(null)
      const hasAny = pipeline.variants.some((v) => v !== null)
      setIconState(hasAny ? "generated" : "idle")
    } else if (pipeline.status === "error") {
      // Restore the icon display to what it was before generation started.
      setIconState(resumeAfterCancelRef.current)
      // Surface the error in a modal. Strip the "Error: " prefix added by the pipeline.
      const raw = pipeline.progress.label
      setErrorTitle("Generation failed")
      setErrorMessage(raw.startsWith("Error: ") ? raw.slice(7) : raw)
    }
  }, [pipeline.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const startGeneration = () => {
    if (!prompt.trim() || iconState === "generating" || attachmentLoading || pipeline.historyError || savingExport) return
    if (!connectionReady) {
      setConnectionRequest((request) => request + 1)
      return
    }
    resumeAfterCancelRef.current =
      iconState === "refine" ? "refine" : iconState === "generated" ? "generated" : "idle"
    setIconState("generating")
    // In refine mode the confirmed variant is the reference; otherwise use the
    // user-attached image (if any).
    const referenceImage = iconState === "refine" ? rawBaseIconSrc : attachment
    pipeline.generate(prompt, referenceImage ?? undefined, iconState === "refine" && !removedIds.has(baseHistoryId) ? baseHistoryId : "")
  }

  const stopGeneration = () => {
    if (pipeline.status === "saving") return
    pipeline.cancel()
    setIconState(resumeAfterCancelRef.current)
  }

  const confirmSelectedVariant = () => {
    if (iconState !== "generated" || selectedVariant === null) return
    setBaseIconSrc(pipeline.variants[selectedVariant])
    setRawBaseIconSrc(pipeline.rawVariants[selectedVariant])
    setBaseHistoryId(pipeline.historyIds[selectedVariant] || "")
    unarchivedSelection.current = pipeline.historyIds[selectedVariant] ? null : selectedVariant
    setIconState("refine")
    setSelectedVariant(null)
    setPrompt("")
    setAttachment(null)
  }

  const continueFromHistory = (saved: GetIconHistoryResponse) => {
    if (!saved.entry) return
    setBaseIconSrc(saved.preparedPng)
    setRawBaseIconSrc(saved.rawPng)
    setBaseHistoryId(saved.entry.id)
    unarchivedSelection.current = null
    setIconState("refine")
    setSelectedVariant(null)
    setPrompt("")
    setAttachment(null)
    setHistoryOpen(false)
  }

  const saveIcon = async (historyId: string, preparedSrc?: string | null) => {
    if (savingExport) return
    setSavingExport(true)
    try {
      const imageData = historyId ? new Uint8Array() : new Uint8Array(await (await fetch(preparedSrc!)).arrayBuffer())
      const saved = await ipc.app.SaveIcon({ imageData, historyId })
      if (!saved.canceled && saved.icnsPath) {
        setSaveSuccess({ folderPath: saved.savedPath, icnsPath: saved.icnsPath })
        setHistoryRevision(value => value + 1)
        if (saved.historyWarning) {
          setErrorTitle("History location wasn’t updated")
          setErrorMessage(saved.historyWarning)
        }
      }
    } finally { setSavingExport(false) }
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
      const id = iconState === "refine" ? baseHistoryId : pipeline.historyIds[selectedVariant!]
      await saveIcon(id && !removedIds.has(id) ? id : "", preparedSrc)
    } catch (error) {
      setErrorTitle("Icon couldn’t be saved")
      setErrorMessage(error instanceof Error ? error.message : "Try saving the icon again.")
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
          ? connectionReady !== null && prompt.trim().length > 0
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
    (pipeline.status === "downloading" || pipeline.status === "saving") && pipeline.progress.label !== ""

  return (
    <div className="dark flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <SquircleClipDefs />

      {errorMessage && (
        <ErrorModal
          title={errorTitle}
          message={errorMessage}
          onClose={() => setErrorMessage(null)}
          onOpenSettings={
            generationErrorSuggestsConnectionIssue(errorMessage)
              ? () => {
                  setErrorMessage(null)
                  setConnectionRequest((request) => request + 1)
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

      <div className="absolute top-3 right-3 z-40 flex items-center gap-2">
        <button type="button" aria-pressed={historyOpen} disabled={iconState === "generating" || !!pipeline.historyError || savingExport}
          onClick={() => setHistoryOpen(value => !value)}
          className={cn("flex items-center gap-2 px-3 h-8 rounded-lg text-xs font-medium non-draggable disabled:opacity-40", historyOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")}>
          <History className="w-3.5 h-3.5" />History
        </button>
        <button
          disabled={!canSave || historyOpen || savingExport}
          onClick={handleSave}
          className={cn(
            "flex items-center gap-2 px-4 h-8 rounded-lg text-sm font-medium transition-all duration-200 non-draggable",
            canSave
              ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.97] shadow-md"
              : "bg-secondary/30 text-muted-foreground/40 cursor-not-allowed"
          )}
        >
          <Download className="w-3.5 h-3.5" />
          {savingExport ? "Saving…" : "Save"}
        </button>
      </div>

      {pipeline.historyError && <div className="absolute top-14 left-4 right-4 z-40 rounded-lg bg-amber-950 text-amber-100 px-3 py-2 text-xs" role="alert">
        {pipeline.historyError} <button className="underline ml-1" onClick={() => void pipeline.retryHistory()} disabled={pipeline.retryingHistory}>{pipeline.retryingHistory ? "Saving…" : "Try again"}</button>
      </div>}

      {historyOpen && <IconHistory onClose={() => setHistoryOpen(false)} onContinue={continueFromHistory}
        onSave={id => saveIcon(id)} onRemoved={id => setRemovedIds(previous => new Set([...previous, id]))}
        revision={historyRevision + pipeline.historyRevision} />}

      <div className="flex min-h-0 flex-1 flex-col" inert={historyOpen} style={{ visibility: historyOpen ? "hidden" : undefined }}>

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
          primaryEnabled={primaryEnabled && !attachmentLoading && pipeline.status !== "saving" && !savingExport && (!pipeline.historyError || primaryAction === "select")}
          onRegenerate={primaryAction === "select" ? startGeneration : undefined}
          regenerateEnabled={prompt.trim().length > 0 && !attachmentLoading && !pipeline.historyError && !savingExport}
          inputDisabled={iconState === "generating"}
          referenceLocked={iconState === "refine"}
          placeholder={inputPlaceholder}
          attachment={attachment}
          onAttachmentChange={setAttachment}
          onAttachmentLoadingChange={setAttachmentLoading}
          settingsControl={<GenerationSettings
            disabled={iconState === "generating"}
            connectionRequest={connectionRequest}
            onReadyChange={setConnectionReady}
          />}
        />
      </div>
      </div>
    </div>
  )
}
