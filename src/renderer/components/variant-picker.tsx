import { IconFace } from "@/components/icon-face"
import { ICON_BODY_SIZE, ICON_SIZE, MACOS_ICON_PATH } from "@/lib/icon-geometry"

export function VariantPicker({
  selected,
  onSelect,
  variants,
}: {
  selected: number | null
  onSelect: (i: number) => void
  variants: (string | null)[]
}) {
  const iconPx = 144
  const selectionRingPx = 4
  // Keep the artwork body at the original UI size; its transparent canvas and
  // shadow extend into the gap. The image itself is never clipped or filtered.
  const cellPx = iconPx + selectionRingPx
  const canvasPx = iconPx * ICON_SIZE / ICON_BODY_SIZE
  const ringStrokeVb = selectionRingPx * ICON_SIZE / canvasPx

  return (
    <div className="flex gap-8">
      {[0, 1, 2].map((i) => {
        const isSelected = selected === i
        const src = variants[i]
        return (
          <button
            key={i}
            onClick={() => onSelect(i)}
            disabled={!src}
            aria-label={`Variant ${i + 1}`}
            aria-pressed={isSelected}
            className="group relative flex items-center justify-center overflow-visible rounded-none focus:outline-none"
            type="button"
            style={{
              width: cellPx,
              height: cellPx,
            }}
          >
            <div
              className="relative z-0 shrink-0"
              style={{
                width: canvasPx,
                height: canvasPx,
              }}
            >
              {src && <IconFace state="generated" src={src} />}
            </div>
            {src && (
              <svg
                className={`pointer-events-none absolute z-10 overflow-visible transition-opacity duration-150 ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"}`}
                width={canvasPx}
                height={canvasPx}
                viewBox={`0 0 ${ICON_SIZE} ${ICON_SIZE}`}
                overflow="visible"
                aria-hidden
              >
                <path
                  d={MACOS_ICON_PATH}
                  fill="none"
                  stroke={isSelected ? "white" : "rgb(156, 163, 175)"}
                  strokeWidth={ringStrokeVb}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        )
      })}
    </div>
  )
}
