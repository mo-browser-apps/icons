import { useEffect, useState } from "react"

const GENERATION_HINT_DELAY_MS = 6_000

function GenerationHintText() {
  return (
    <>
      <p className="text-sm font-medium text-foreground/80">Generating 3 variants of your icon…</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        This can take several minutes.
      </p>
    </>
  )
}

/** Mounted only while generating, so each attempt gets a fresh delay. */
export function GenerationHint() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(true), GENERATION_HINT_DELAY_MS)
    return () => window.clearTimeout(timeout)
  }, [])

  return (
    <div className="mt-5 grid w-80 max-w-full text-center">
      {/* Reserve the wrapped text's height, including at higher UI zoom. */}
      <div aria-hidden="true" className="invisible col-start-1 row-start-1">
        <GenerationHintText />
      </div>
      {/* Keep the live region empty until the delay expires. */}
      <div role="status" aria-atomic="true" className="col-start-1 row-start-1">
        {visible && (
          <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
            <GenerationHintText />
          </div>
        )}
      </div>
    </div>
  )
}
