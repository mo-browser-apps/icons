import { IconFace } from "@/components/icon-face"
import { IconPreviewButton } from "@/components/icon-preview-button"
import { ICON_BODY_SIZE, ICON_SIZE } from "@/lib/icon-geometry"

export function SingleRefineIcon({ src }: { src?: string | null }) {
  const canvasPx = 144 * ICON_SIZE / ICON_BODY_SIZE
  return (
    <div className="relative" style={{ width: 144, height: 144 }}>
      <IconPreviewButton src={src} className="single-preview">
        <div className="single-preview-canvas" style={{ width: canvasPx, height: canvasPx }}>
          {src && <IconFace state="generated" src={src} />}
        </div>
      </IconPreviewButton>
    </div>
  )
}
