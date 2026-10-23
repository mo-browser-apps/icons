import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { RefreshCw, Settings2, X } from "lucide-react"
import { ipc } from "@/gen/ipc"
import type { GetGenerationSettingsResponse, ImageModelOption } from "@/gen/app"

const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

function defaultsFor(model: ImageModelOption, quality = "") {
  return {
    model: model.id,
    quality: model.qualities.includes(quality) ? quality : model.qualities[0] || "",
  }
}

export function GenerationSettings({ disabled, onManageKey }: {
  disabled: boolean
  onManageKey: () => void
}) {
  const [settings, setSettings] = useState<GetGenerationSettingsResponse | null>(null)
  const [draft, setDraft] = useState({ model: "", quality: "" })
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let active = true
    ipc.app.GetGenerationSettings({ refresh: false }).then((response) => {
      if (!active) return
      setSettings(response)
      const model = response.models.find((item) => item.id === response.model)
      setDraft(model ? defaultsFor(model, response.quality)
        : { model: response.model, quality: response.quality })
      setError(response.error)
    }).catch(() => {
      if (active) setError("Could not load generation settings. Try again.")
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (open) dialog.current?.showModal()
    else dialog.current?.close()
  }, [open])

  const selected = settings?.models.find((model) => model.id === draft.model)
  const current = settings?.models.find((model) => model.id === settings.model)
  const close = () => {
    if (saving) return
    setOpen(false)
    trigger.current?.focus()
  }
  const show = () => {
    if (settings) {
      setDraft(current ? defaultsFor(current, settings.quality)
        : { model: settings.model, quality: settings.quality })
      setError(settings.error)
    }
    setOpen(true)
  }
  const refresh = async () => {
    setLoading(true)
    setError("")
    try {
      const response = await ipc.app.GetGenerationSettings({ refresh: true })
      setSettings(response)
      const model = response.models.find((item) => item.id === draft.model || (!draft.model && item.id === response.model))
      if (model) setDraft(defaultsFor(model, draft.quality || response.quality))
      setError(response.error)
    } catch {
      setError("Could not refresh models. Try again.")
    } finally { setLoading(false) }
  }
  const save = async () => {
    if (!settings || !selected) return
    setSaving(true)
    setError("")
    try {
      const response = await ipc.app.SetGenerationSettings({ provider: settings.provider, ...draft })
      if (response.error) { setError(response.error); return }
      setSettings({ ...settings, ...draft, error: "" })
      setOpen(false)
      trigger.current?.focus()
    } catch {
      setError("Could not save generation settings. Try again.")
    } finally { setSaving(false) }
  }

  return <>
    <button
      ref={trigger}
      type="button"
      onClick={show}
      disabled={disabled}
      title="Model and quality"
      aria-label="Generation settings"
      className="flex items-center gap-1.5 h-8 max-w-56 px-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors disabled:opacity-50"
    >
      <Settings2 className="w-4 h-4 shrink-0" />
      <span className="truncate text-xs">{current?.name || settings?.model || "Choose model"}</span>
    </button>
    {createPortal(
      <dialog
        ref={dialog}
        aria-labelledby="generation-settings-title"
        style={{ colorScheme: "dark", scrollbarWidth: "thin", scrollbarColor: "#444 transparent" }}
        onCancel={(event) => { event.preventDefault(); close() }}
        className="dark fixed inset-0 m-auto w-[440px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] overflow-y-auto rounded-2xl border border-border bg-background text-foreground p-0 shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm"
      >
        <div className="flex items-center justify-between px-5 pt-5">
          <div>
            <h2 id="generation-settings-title" className="text-base font-medium">Generation settings</h2>
            <p className="text-xs text-muted-foreground mt-1">{settings?.provider === "openrouter" ? "OpenRouter" : settings?.provider === "mock" ? "Local preview" : "OpenAI"}</p>
          </div>
          <button type="button" onClick={close} disabled={saving} aria-label="Close generation settings" className="p-1.5 rounded-lg hover:bg-secondary disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="generation-model" className="text-sm font-medium">Model</label>
              <button type="button" onClick={refresh} disabled={loading || saving} aria-label="Refresh models" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
                <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                {loading ? "Loading…" : "Refresh"}
              </button>
            </div>
            <select
              id="generation-model"
              value={draft.model}
              disabled={loading || saving || !settings?.models.length}
              onChange={(event) => {
                const model = settings?.models.find((item) => item.id === event.target.value)
                if (model) { setDraft(defaultsFor(model, draft.quality)); setError("") }
              }}
              className="w-full h-10 rounded-lg border border-border bg-secondary px-3 text-sm outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            >
              {!selected && <option value={draft.model} disabled>{loading ? "Loading models…" : "Choose a model"}</option>}
              {settings?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </div>
          {!!selected?.qualities.length && <fieldset disabled={loading || saving}>
            <legend className="text-sm font-medium mb-2">Quality</legend>
            <div className="flex flex-wrap gap-1 rounded-lg bg-secondary/60 p-1">
              {selected.qualities.map((quality) => <button
                key={quality} type="button" aria-pressed={draft.quality === quality}
                onClick={() => { setDraft({ ...draft, quality }); setError("") }}
                className={`flex-1 py-1.5 px-2 rounded-md text-xs transition-colors ${draft.quality === quality ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >{label(quality)}</button>)}
            </div>
            <p className="text-xs text-muted-foreground mt-2">{draft.quality === "auto" ? "The model chooses the quality automatically." : "Higher quality can take longer and cost more."}</p>
          </fieldset>}
          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex items-center justify-between gap-3 px-5 pb-5">
          <button type="button" disabled={saving} onClick={() => { close(); onManageKey() }} className="h-9 px-3 rounded-lg text-xs bg-secondary text-muted-foreground hover:text-foreground">API key</button>
          <button type="button" onClick={save} disabled={loading || saving || !selected} className="h-9 px-4 rounded-lg text-xs font-medium bg-primary text-primary-foreground disabled:opacity-40">
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </dialog>, document.body
    )}
  </>
}
