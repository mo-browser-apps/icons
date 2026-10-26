import {
  useEffect,
  useRef,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
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
    reader.onloadend = () => resolve(reader.result as string)
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
  placeholder,
  attachments,
  onAttachmentsChange,
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
  placeholder: string
  attachments: string[]
  onAttachmentsChange: Dispatch<SetStateAction<string[]>>
  settingsControl: ReactNode
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (primaryAction === "select") return
      if (primaryEnabled) onPrimary()
    }
  }

  // Open the native file picker in the main process (reliable in MoBrowser),
  // then store the chosen image as a data URL.
  const handleAttachClick = async () => {
    try {
      const res = await ipc.app.PickReferenceImage({})
      if (res.canceled || !res.imageB64) return
      const dataUrl = `data:${res.mime || "image/png"};base64,${res.imageB64}`
      onAttachmentsChange((current) => [...current, dataUrl])
    } catch {
      // Ignore; the user can retry.
    }
  }

  const removeAttachment = (index: number) => {
    onAttachmentsChange((current) => current.filter((_, i) => i !== index))
  }

  // Paste an image (⌘V) anywhere in the app to attach it as a reference.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (inputDisabled) return
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (files.length === 0) return
      // Image present: don't let the raw bytes land in the textarea.
      e.preventDefault()
      Promise.all(files.map(readAsDataUrl))
        .then((urls) =>
          onAttachmentsChange((current) => [...current, ...urls])
        )
        .catch(() => {})
    }
    document.addEventListener("paste", onPaste)
    return () => document.removeEventListener("paste", onPaste)
  }, [onAttachmentsChange, inputDisabled])

  return (
    <div
      className={cn(
        "w-full rounded-4xl border border-border bg-secondary/40 transition-all duration-200",
        "focus-within:border-border/80 focus-within:bg-secondary/60 p-3"
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
            className={cn(
              "flex items-center justify-center w-8 h-8 rounded-full",
              "text-muted-foreground hover:text-foreground hover:bg-white/10",
              "transition-colors shrink-0"
            )}
            title="Attach reference image"
            aria-label="Attach reference image"
          >
            <ImagePlus className="w-4 h-4" />
          </button>

          {settingsControl}

          {/* Inline attachment thumbnails — same row, no height change. */}
          {attachments.map((src, i) => (
            <div
              key={i}
              className="relative group w-7 h-7 rounded-lg overflow-hidden shrink-0"
            >
              <img src={src} alt="Reference" className="w-full h-full object-cover" />
              <button
                onClick={() => removeAttachment(i)}
                className="absolute inset-0 flex items-center justify-center bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3 text-white" />
              </button>
            </div>
          ))}
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
