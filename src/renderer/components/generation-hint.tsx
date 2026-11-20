import { useEffect, useState } from "react"

const GENERATION_HINT_DELAY_MS = 6_000

/** Mounted only while generating, so each attempt gets a fresh delay. */
export function GenerationHint() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(true), GENERATION_HINT_DELAY_MS)
    return () => window.clearTimeout(timeout)
  }, [])

  return (
    // Reserve space so the animation stays put when the message appears.
    <div role="status" aria-atomic="true" className="mt-5 min-h-16 w-80 max-w-full text-center">
      {visible && (
        <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
          <p className="text-sm font-medium text-foreground/80">Still creating your icons…</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Generation can take a little while.<br />Thanks for your patience.
          </p>
        </div>
      )}
    </div>
  )
}
