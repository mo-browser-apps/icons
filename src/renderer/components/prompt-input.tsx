import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import {
  ArrowUp,
  ChevronRight,
  ImagePlus,
  RefreshCw,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { ipc } from "@/gen/ipc"

export type PrimaryAction = "submit" | "stop" | "refresh" | "select"

/** Read a File/Blob into a `data:` URL. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function PromptInput({
  value,
  onChange,
  primaryAction,
  onPrimary,
  primaryEnabled,
  onRegenerate,
  regenerateEnabled,
  inputDisabled,
  referenceLocked,
  placeholder,
  attachment,
  onAttachmentChange,
  onAttachmentLoadingChange,
  settingsControl,
}: {
  value: string
  onChange: (v: string) => void
  primaryAction: PrimaryAction
  onPrimary: () => void
  primaryEnabled: boolean
  onRegenerate?: () => void
  regenerateEnabled?: boolean
  inputDisabled: boolean
  referenceLocked: boolean
  placeholder: string
  attachment: string | null
  onAttachmentChange: (url: string | null) => void
  onAttachmentLoadingChange: (loading: boolean) => void
  settingsControl: ReactNode
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachmentRequest = useRef(0)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [attachmentLoading, setAttachmentLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const attachmentDisabled = inputDisabled || referenceLocked

  const setLoading = useCallback((loading: boolean) => {
    setAttachmentLoading(loading)
    onAttachmentLoadingChange(loading)
  }, [onAttachmentLoadingChange])

  // Invalidate pending file reads when generation/refinement starts or we unmount.
  useEffect(() => {
    setLoading(false)
    setAttachmentError(null)
    setDragging(false)
    return () => { attachmentRequest.current += 1 }
  }, [attachmentDisabled, setLoading])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (primaryAction === "select") return
      if (primaryEnabled) onPrimary()
    }
  }

  const loadReference = useCallback(async (read: () => Promise<string | null>) => {
    if (attachmentDisabled) return
    const request = ++attachmentRequest.current
    setAttachmentError(null)
    setLoading(true)
    try {
      const url = await read()
      if (!url || request !== attachmentRequest.current) return
      // Decode before showing the preview: extensions and MIME labels alone do
      // not establish that the file is a readable image.
      try {
        const bitmap = await createImageBitmap(await fetch(url).then((res) => res.blob()))
        bitmap.close()
      } catch {
        throw new Error("This image could not be opened. Choose a valid PNG, JPEG, WebP or GIF.")
      }
      if (request === attachmentRequest.current) onAttachmentChange(url)
    } catch (error) {
      if (request === attachmentRequest.current) {
        setAttachmentError(error instanceof Error ? error.message : "Could not read that image. Please try another file.")
      }
    } finally {
      if (request === attachmentRequest.current) setLoading(false)
    }
  }, [attachmentDisabled, onAttachmentChange, setLoading])

  // Native picking, pasting and dropping all replace the same single reference.
  const handleAttachClick = () => loadReference(async () => {
    const res = await ipc.app.PickReferenceImage({})
    if (res.error) throw new Error("Could not read that image. Check that the file is accessible and try again.")
    if (res.canceled) return null
    if (!res.imageB64) throw new Error("That file is empty. Choose another image.")
    return `data:${res.mime || "image/png"};base64,${res.imageB64}`
  })

  const removeAttachment = () => {
    if (attachmentDisabled) return
    attachmentRequest.current += 1
    setLoading(false)
    setAttachmentError(null)
    onAttachmentChange(null)
  }

  useEffect(() => {
    const attachFiles = (files: File[]) => {
      if (attachmentDisabled || document.querySelector("dialog[open]")) return
      void loadReference(async () => {
        if (files.length !== 1) throw new Error("Attach one reference image at a time.")
        const file = files[0]
        if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) &&
            !(file.type === "" && /\.(png|jpe?g|webp|gif)$/i.test(file.name))) {
          throw new Error("Choose a PNG, JPEG, WebP or GIF image.")
        }
        return readAsDataUrl(file)
      })
    }
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      // Some clipboard sources expose files only through items. Prefer the
      // FileList when present so the same image is never attached twice.
      if (!files.length) {
        for (const item of Array.from(event.clipboardData?.items ?? [])) {
          const file = item.kind === "file" ? item.getAsFile() : null
          if (file) files.push(file)
        }
      }
      if (!files.length) return
      event.preventDefault()
      attachFiles(files)
    }
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return
      event.preventDefault()
      event.dataTransfer.dropEffect = attachmentDisabled ? "none" : "copy"
      if (!attachmentDisabled && !document.querySelector("dialog[open]")) setDragging(true)
    }
    const onDragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      setDragging(false)
      if (!event.dataTransfer?.types.includes("Files")) return
      // Never navigate the app to a dropped file, even while generation runs.
      event.preventDefault()
      attachFiles(Array.from(event.dataTransfer.files))
    }
    document.addEventListener("paste", onPaste)
    document.addEventListener("dragover", onDragOver)
    document.addEventListener("dragleave", onDragLeave)
    document.addEventListener("drop", onDrop)
    return () => {
      document.removeEventListener("paste", onPaste)
      document.removeEventListener("dragover", onDragOver)
      document.removeEventListener("dragleave", onDragLeave)
      document.removeEventListener("drop", onDrop)
    }
  }, [attachmentDisabled, loadReference])

  return (
    <div
      className={cn(
        "w-full rounded-4xl border border-border bg-secondary/40 transition-all duration-200",
        "focus-within:border-border/80 focus-within:bg-secondary/60 p-3",
        dragging && "border-primary bg-primary/10"
      )}
    >
      {/* Textarea. */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={inputDisabled}
        placeholder={placeholder}
        rows={2}
        className={cn(
          "w-full bg-transparent resize-none border-0 outline-none ring-0",
          "text-sm text-foreground placeholder:text-muted-foreground",
          "leading-relaxed overflow-y-auto m-1.5",
          inputDisabled && "opacity-60"
        )}
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.15) transparent" }}
      />

      <div className="px-1.5 pb-2 text-xs text-muted-foreground" aria-live="polite">
        {referenceLocked
          ? "Using the selected icon as the reference."
          : attachmentLoading
            ? "Opening image…"
            : dragging
              ? "Drop one reference image here."
              : attachment
                ? "One reference image · attach, paste or drop to replace."
                : "Attach, paste or drop one reference image."}
      </div>
      {attachmentError && (
        <p role="alert" className="px-1.5 pb-2 text-xs text-destructive">{attachmentError}</p>
      )}

      {/* Bottom action bar. */}
      <div className="flex items-center justify-between">
        <div
          className={cn(
            "flex items-center gap-0.5",
            inputDisabled && "pointer-events-none opacity-60"
          )}
        >
          {/* Attach reference image — opens the native file dialog via IPC. */}
          <button
            type="button"
            onClick={handleAttachClick}
            disabled={attachmentDisabled || attachmentLoading}
            className={cn(
              "flex items-center justify-center w-8 h-8 rounded-full",
              "text-muted-foreground hover:text-foreground hover:bg-white/10",
              "transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            )}
            title={referenceLocked ? "Refinements use the selected icon" : attachment ? "Replace reference image" : "Attach reference image"}
            aria-label="Attach reference image"
          >
            <ImagePlus className="w-4 h-4" />
          </button>

          {settingsControl}

          {/* Inline attachment thumbnails — same row, no height change. */}
          {attachment && (
            <div
              className="relative group w-7 h-7 rounded-lg overflow-hidden shrink-0"
            >
              <img src={attachment} alt="Reference" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={removeAttachment}
                disabled={attachmentDisabled}
                aria-label="Remove reference image"
                className="absolute inset-0 flex items-center justify-center bg-black/70 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3 text-white" />
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {onRegenerate != null && (
            <button
              type="button"
              onClick={onRegenerate}
              disabled={!regenerateEnabled}
              className={cn(
                "flex items-center justify-center rounded-full transition-all duration-200 shrink-0 w-8 min-w-8 h-8 px-0",
                regenerateEnabled
                  ? "bg-secondary/70 text-foreground hover:bg-secondary shadow-sm"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
              title="Regenerate: three new variants from the same prompt"
              aria-label="Regenerate"
            >
              <RefreshCw className="w-4 h-4" strokeWidth={2.5} />
            </button>
          )}
          <button
            type="button"
            onClick={onPrimary}
            disabled={!primaryEnabled}
            className={cn(
              "flex items-center justify-center gap-0.5 rounded-full transition-all duration-200 shrink-0 h-8 font-medium text-xs",
              primaryAction === "select" ? "min-w-[88px] px-3" : "w-8 min-w-8 px-0",
              primaryEnabled
                ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
                : "bg-muted text-muted-foreground cursor-not-allowed"
            )}
            title={
              primaryAction === "stop"
                ? "Stop generation"
                : primaryAction === "refresh"
                  ? "Re-generate all variants (Enter)"
                  : primaryAction === "select"
                    ? "Use this design as the base: remove other variants, then describe how to build three new ones"
                    : "Generate (Enter)"
            }
            aria-label={
              primaryAction === "stop"
                ? "Stop"
                : primaryAction === "refresh"
                  ? "Refresh"
                  : primaryAction === "select"
                    ? "Select"
                    : "Submit"
            }
          >
            {primaryAction === "stop" && (
              <span className="w-2.5 h-2.5 rounded-[1px] bg-current" aria-hidden />
            )}
            {primaryAction === "refresh" && <RefreshCw className="w-4 h-4" strokeWidth={2.5} />}
            {primaryAction === "submit" && <ArrowUp className="w-4 h-4" strokeWidth={2.5} />}
            {primaryAction === "select" && (
              <>
                <span>Select</span>
                <ChevronRight className="w-3.5 h-3.5" strokeWidth={2.5} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
