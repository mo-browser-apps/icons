import { useState, type ReactNode } from 'react'
import { Maximize2 } from 'lucide-react'
import { ipc } from '@/gen/ipc'
import { imageUrlToPngBase64 } from '@/lib/image-normalization'
import './icon-preview.css'

let latestOpener = 0

export function IconPreviewButton({ src, title = 'Icon preview', label = 'Preview icon', children, className = '', normalize = false }: {
  src?: string | null; title?: string; label?: string; children?: ReactNode; className?: string; normalize?: boolean
}) {
  const [error, setError] = useState('')
  return <>
    <button type="button" aria-label={label} disabled={!src}
      className={`icon-preview-button ${className}`} onClick={async event => {
        if (!src) return
        const trigger = event.currentTarget, opener = ++latestOpener
        setError('')
        // Open resolves on close. Keep this trigger available so it can reuse
        // the viewer, including when History switches the image in this button.
        try {
          const png = normalize ? `data:image/png;base64,${await imageUrlToPngBase64(src)}` : src
          if (opener !== latestOpener) return
          await ipc.preview.Open({ png, title })
        }
        catch { setError('Preview couldn’t open. Please try again.') }
        finally {
          requestAnimationFrame(() => { if (trigger.isConnected && opener === latestOpener) trigger.focus() })
        }
      }}>
      {children ?? <><Maximize2 aria-hidden="true" size={12} />Preview</>}
    </button>
    {error && <span className="icon-preview-error" role="alert">{error}</span>}
  </>
}
