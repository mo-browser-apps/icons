import { Sparkles } from "lucide-react"
import { BlueprintFace } from "@/components/blueprint-face"
import type { IconState } from "@/components/icon-types"
import {
  ICON_FACE_EDGE_DEFAULT,
  SQUICLE_PATH_100,
} from "@/components/squircle"

export function IconFace({
  state,
  src,
  squircleEdgeStroke = ICON_FACE_EDGE_DEFAULT,
  squircleEdgeWidth = "0.4",
}: {
  state: IconState
  /** Generated image URL.  When provided the image is shown instead of the placeholder. */
  src?: string | null
  /** SVG path stroke; defaults to a light hairline. */
  squircleEdgeStroke?: string
  /** Stroke width in the 0–100 viewBox. */
  squircleEdgeWidth?: string
}) {
  // Finished artwork already includes its mask and shadow. UI decoration must
  // not add an edge or another shadow that will be absent from the saved file.
  if (src) {
    return <img src={src} alt="Generated icon" className="absolute inset-0 w-full h-full object-contain" draggable={false} />
  }

  return (
    <>
      {state === "generated" ? (
        <>
          <div className="absolute inset-0 bg-linear-to-br from-violet-600 via-indigo-500 to-blue-400" />
          <div
            className="absolute inset-x-0 top-0 h-1/2 pointer-events-none"
            style={{
              background: "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, transparent 100%)",
            }}
          />
          <div className="relative flex items-center justify-center h-full">
            <Sparkles className="w-12 h-12 text-white" strokeWidth={1.5} />
          </div>
        </>
      ) : (
        <BlueprintFace scanning={state === "generating"} />
      )}

      {/* Subtle edge along the superellipse, matches clip shape at any size. */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden
      >
        <path
          d={SQUICLE_PATH_100}
          fill="none"
          stroke={squircleEdgeStroke}
          strokeWidth={squircleEdgeWidth}
        />
      </svg>
    </>
  )
}
