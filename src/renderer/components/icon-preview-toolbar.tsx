import { useEffect, useRef, useState } from 'react'
import { Grid2X2, Maximize2, Minus, Plus, X } from 'lucide-react'
import { ipc } from '@/gen/ipc'
import type { IconPreviewState } from '@/gen/preview'
import './icon-preview.css'

export function IconPreviewToolbar() {
  const [state, setState] = useState<IconPreviewState>()
  const [error, setError] = useState('')
  const close = useRef<HTMLButtonElement>(null)
  const focusRequest = useRef(0)
  const command = (action: string) => {
    setError('')
    // Watch is the single source of state; an older RPC response must not
    // overwrite a newer browser factorChanged notification.
    void ipc.preview.Command({ action, factor: 1 }).catch(() => setError('Couldn’t update preview. Try again.'))
  }
  useEffect(() => {
    const subscription = ipc.preview.Watch({}).subscribe({ next: next => {
      setState(next)
      if (next.focusRequest !== focusRequest.current) {
        focusRequest.current = next.focusRequest
        requestAnimationFrame(() => {
          const buttons = [...document.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          ;(next.focusLast ? buttons.at(-1) : buttons[0])?.focus()
        })
      }
    }, error: () => setError('Preview disconnected. Close and reopen it.') })
    close.current?.focus()
    const key = (event: KeyboardEvent) => {
      let action = ''
      if (event.key === 'Escape') action = 'close'
      else if (event.key === '+' || event.key === '=') action = 'in'
      else if (event.key === '-') action = 'out'
      else if ((event.metaKey || event.ctrlKey) && event.key === '0') action = 'actual'
      else if ((event.metaKey || event.ctrlKey) && event.key === '9') action = 'fit'
      else if (event.key === 'Tab') {
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        if ((!event.shiftKey && document.activeElement === buttons.at(-1)) || (event.shiftKey && document.activeElement === buttons[0])) action = 'image'
      }
      if (action) { event.preventDefault(); command(action) }
    }
    document.addEventListener('keydown', key)
    return () => { subscription.unsubscribe(); document.removeEventListener('keydown', key) }
  }, [])
  return <main className="preview-toolbar dark" aria-label="Icon preview controls">
    <div className="preview-title"><span>{state?.title || 'Icon preview'}</span><span className="preview-dimensions">{state?.width ? `${state.width} × ${state.height}` : ''}</span></div>
    <div className="preview-controls">
      <div className="preview-control-group" aria-label="Zoom">
        <button aria-label="Zoom out" title="Zoom out (⌘− / Ctrl−)" disabled={!state || state.factor <= .251} onClick={() => command('out')}><Minus size={16} /></button>
        <output aria-live="polite" aria-label="Zoom level">{state ? `${Math.round(state.factor * 100)}%` : '…'}</output>
        <button aria-label="Zoom in" title="Zoom in (⌘+ / Ctrl+)" disabled={!state || state.factor >= 3.999} onClick={() => command('in')}><Plus size={16} /></button>
      </div>
      <button aria-pressed={state?.fit ?? true} title="Fit (⌘9 / Ctrl9)" onClick={() => command('fit')}><Maximize2 size={14} />Fit</button>
      <button aria-pressed={!!state && !state.fit && Math.abs(state.factor - 1) < .001} title="Actual size (⌘0 / Ctrl0)" onClick={() => command('actual')}>100%</button>
      <button aria-label="Show transparency" aria-pressed={state?.transparency ?? false} title="Show transparency" onClick={() => command('transparency')}><Grid2X2 size={16} /><span className="preview-background-label">Transparency</span></button>
      <button ref={close} className="preview-close" aria-label="Close preview" title="Close preview (Esc)" onClick={() => command('close')}><X size={16} /></button>
    </div>
    {error && <div className="preview-toolbar-error" role="alert">{error}</div>}
  </main>
}
