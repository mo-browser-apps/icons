import { useCallback, useEffect, useState } from "react"
import { Check, Copy, X } from "lucide-react"
import { cn } from "@/lib/utils"

/** True when generation settings offer a useful way to recover. */
export function generationErrorSuggestsConnectionIssue(message: string): boolean {
  const m = message.toLowerCase()
  if (m.includes("codex") || m.includes("chatgpt")) return true
  if (/\b401\b/.test(m) || /\b403\b/.test(m)) {
    return true
  }
  if (m.includes("invalid_api_key")) {
    return true
  }
  if (m.includes("incorrect api key")) {
    return true
  }
  if (m.includes("invalid bearer")) {
    return true
  }
  if (m.includes("unauthorized")) {
    return true
  }
  if (m.includes("authentication") && m.includes("openai")) {
    return true
  }
  if (
    m.includes("api key") &&
    (m.includes("invalid") ||
      m.includes("incorrect") ||
      m.includes("expired") ||
      m.includes("revoked") ||
      m.includes("not found"))
  ) {
    return true
  }
  return false
}

export function ErrorModal({
  message,
  onClose,
  onOpenSettings,
}: {
  message: string
  onClose: () => void
  onOpenSettings?: () => void
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [message])

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Panel — stop propagation so clicks inside don't close the modal. */}
      <div
        className="relative w-[420px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border">
          <span className="text-sm font-medium text-destructive">Generation failed</span>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Error text — selectable, scrollable. */}
        <div className="px-4 py-3">
          <pre
            className={cn(
              "text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all",
              "max-h-52 overflow-y-auto select-text",
            )}
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.15) transparent" }}
          >
            {message}
          </pre>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 flex-wrap px-4 pb-4">
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              "flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium transition-all duration-150",
              copied
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary",
            )}
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className={cn(
              "h-8 px-4 rounded-lg text-xs font-medium transition-colors",
              onOpenSettings
                ? "bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            Dismiss
          </button>
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="h-8 px-4 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Generation settings
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
