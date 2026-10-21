import { IconFace } from "@/components/icon-face"
import { ICON_BODY_SIZE, ICON_SIZE } from "@/lib/icon-geometry"

export function SingleRefineIcon({ src }: { src?: string | null }) {
  const canvasPx = 144 * ICON_SIZE / ICON_BODY_SIZE
  return (
    <div className="relative flex items-center justify-center" style={{ width: 144, height: 144 }}>
      <div className="relative shrink-0" style={{ width: canvasPx, height: canvasPx }}>
        {src && <IconFace state="generated" src={src} />}
      </div>
    </div>
  )
}
