import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, Eye, EyeOff, RefreshCw, Settings2, X } from "lucide-react"
import { ipc } from "@/gen/ipc"
import type { GetGenerationSettingsResponse, ImageModelOption } from "@/gen/app"

const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

function defaultsFor(model: ImageModelOption, quality = "") {
  return {
    model: model.id,
    quality: model.qualities.includes(quality) ? quality : model.qualities[0] || "",
  }
}

function savedDraft(settings: GetGenerationSettingsResponse) {
  const model = settings.models.find((item) => item.id === settings.model) ?? settings.models[0]
  return model ? defaultsFor(model, settings.quality) : { model: settings.model, quality: settings.quality }
}

const needsKey = (settings: GetGenerationSettingsResponse) =>
  settings.apiKeyRequired && (!settings.hasApiKey || settings.errorCode === "invalid_key")

export function GenerationSettings({ disabled, keyRequest, onKeyReadyChange }: {
  disabled: boolean
  keyRequest: number
  onKeyReadyChange: (ready: boolean) => void
}) {
  const [settings, setSettings] = useState<GetGenerationSettingsResponse | null>(null)
  const [draft, setDraft] = useState({ model: "", quality: "" })
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<"key" | "models" | "remove">("models")
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const requestVersion = useRef(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const keyInput = useRef<HTMLInputElement>(null)
  const modelInput = useRef<HTMLSelectElement>(null)
  const cancelRemoval = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const version = ++requestVersion.current
    ipc.app.GetGenerationSettings({ refresh: false }).then((response) => {
      if (version !== requestVersion.current) return
      setSettings(response)
      setDraft(savedDraft(response))
      setError(response.error)
      onKeyReadyChange(!needsKey(response))
      if (needsKey(response)) { setStep("key"); setOpen(true) }
    }).catch(() => {
      if (version === requestVersion.current) {
        setError("Could not load generation settings. Try again.")
        onKeyReadyChange(false)
      }
    }).finally(() => { if (version === requestVersion.current) setLoading(false) })
    return () => { requestVersion.current++ }
  }, [onKeyReadyChange])

  const editKey = () => {
    requestVersion.current++
    setLoading(false)
    setStep("key")
    setApiKey("")
    setShowKey(false)
    setError("")
    setOpen(true)
  }

  useEffect(() => {
    if (keyRequest) editKey()
  }, [keyRequest])

  useEffect(() => {
    if (open) {
      dialog.current?.showModal()
      if (step === "key") keyInput.current?.focus()
      else if (step === "remove") cancelRemoval.current?.focus()
      else modelInput.current?.focus()
    } else dialog.current?.close()
  }, [open, step])

  const selected = settings?.models.find((model) => model.id === draft.model)
  const current = settings?.models.find((model) => model.id === settings.model)
  const close = () => {
    if (saving) return
    requestVersion.current++
    setLoading(false)
    setApiKey("")
    setShowKey(false)
    setOpen(false)
    trigger.current?.focus()
  }
  const show = () => {
    if (settings) {
      setDraft(savedDraft(settings))
      setError(settings.error)
      setStep(needsKey(settings) ? "key" : "models")
    }
    setOpen(true)
  }
  const refresh = async () => {
    const version = ++requestVersion.current
    setLoading(true)
    setError("")
    try {
      const response = await ipc.app.GetGenerationSettings({ refresh: true })
      if (version !== requestVersion.current) return
      setSettings(response)
      setDraft((latest) => {
        const model = response.models.find((item) => item.id === latest.model)
        return model ? defaultsFor(model, latest.quality) : savedDraft(response)
      })
      setError(response.error)
      onKeyReadyChange(!needsKey(response))
      if (needsKey(response)) setStep("key")
    } catch {
      if (version === requestVersion.current) setError("Could not refresh models. Try again.")
    } finally { if (version === requestVersion.current) setLoading(false) }
  }
  const checkKey = async () => {
    if (saving || !apiKey.trim()) return
    const version = ++requestVersion.current
    setSaving(true)
    setError("")
    try {
      const response = await ipc.app.SetOpenAIApiKey({ apiKey: apiKey.trim() })
      if (version !== requestVersion.current) return
      if (response.error || !response.settings) {
        setError(response.error || "Could not check the API key. Try again.")
        return
      }
      setSettings(response.settings)
      setDraft(savedDraft(response.settings))
      onKeyReadyChange(true)
      setApiKey("")
      setShowKey(false)
      setStep("models")
    } catch {
      if (version === requestVersion.current) setError("Could not check the API key. Try again.")
    } finally { if (version === requestVersion.current) setSaving(false) }
  }
  const save = async () => {
    if (!settings || !selected || saving) return
    setSaving(true)
    setError("")
    try {
      const response = await ipc.app.SetGenerationSettings({ provider: settings.provider, ...draft })
      if (response.error) { setError(response.error); return }
      setSettings({ ...settings, ...draft, error: "", errorCode: "" })
      setOpen(false)
      trigger.current?.focus()
    } catch {
      setError("Could not save generation settings. Try again.")
    } finally { setSaving(false) }
  }
  const removeKey = async () => {
    if (saving || !settings?.hasApiKey) return
    const version = ++requestVersion.current
    setSaving(true)
    setError("")
    try {
      const response = await ipc.app.RemoveApiKey({})
      if (version !== requestVersion.current) return
      if (response.error) { setError(response.error); return }
      setSettings({ ...settings, hasApiKey: false, models: [], error: "", errorCode: "" })
      setDraft({ model: "", quality: "" })
      setApiKey("")
      setShowKey(false)
      onKeyReadyChange(false)
      setStep("key")
    } catch {
      if (version === requestVersion.current) setError("Could not remove the API key. Try again.")
    } finally { if (version === requestVersion.current) setSaving(false) }
  }

  return <>
    <button
      ref={trigger}
      type="button"
      onClick={show}
      disabled={disabled || (loading && !settings)}
      title="Model and quality"
      aria-label="Generation settings"
      className="flex items-center gap-1.5 h-8 max-w-56 px-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors disabled:opacity-50"
    >
      <Settings2 className="w-4 h-4 shrink-0" />
      <span className="truncate text-xs">{settings && needsKey(settings) ? "Add API key" : current?.name || settings?.model || "Generation settings"}</span>
    </button>
    {createPortal(
      <dialog
        ref={dialog}
        aria-labelledby="generation-settings-title"
        aria-describedby="generation-settings-description"
        style={{ colorScheme: "dark", scrollbarWidth: "thin", scrollbarColor: "#444 transparent" }}
        onCancel={(event) => { event.preventDefault(); close() }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          event.stopPropagation()
          if (step === "remove" && !saving) { setStep("key"); setError("") }
          else close()
        }}
        className="dark fixed inset-0 m-auto w-[440px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] overflow-y-auto rounded-2xl border border-border bg-background text-foreground p-0 shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm"
      >
        <div className="px-5 pt-4">
          <div className="flex items-center justify-between gap-3">
            <h2 id="generation-settings-title" className="text-base font-medium">{step === "remove" ? "Remove API key?" : step === "key" ? "API key" : "Generation settings"}</h2>
            <button type="button" onClick={close} disabled={saving} aria-label="Close generation settings" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-secondary disabled:opacity-50">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p id="generation-settings-description" className="text-xs text-muted-foreground mt-1">{step === "remove" ? "Disconnect image generation from this app." : step === "key"
            ? "Connect OpenAI or OpenRouter to generate icons."
            : settings?.provider === "openrouter" ? "OpenRouter" : settings?.provider === "mock" ? "Local preview" : settings ? "OpenAI" : "Choose your model and quality."}</p>
        </div>
        <form onSubmit={(event) => {
          event.preventDefault()
          if (step === "remove") void removeKey()
          else if (step === "key") void checkKey()
          else void save()
        }} aria-busy={saving || loading}>
          <div className="px-5 py-5 space-y-4">
            {step === "remove" ? <p className="text-sm text-muted-foreground">You’ll need to add an API key to generate icons again. Your model and quality choices will be kept.</p> : step === "key" ? <div>
              <label htmlFor="generation-api-key" className="block text-sm font-medium mb-2">{settings?.hasApiKey ? "New API key" : "API key"}</label>
              <div className="relative">
                <input
                  ref={keyInput} id="generation-api-key" type={showKey ? "text" : "password"}
                  value={apiKey} onChange={(event) => { setApiKey(event.target.value); setError("") }}
                  placeholder="Paste your API key" disabled={saving}
                  autoComplete="off" autoCapitalize="none" spellCheck={false}
                  aria-describedby={error ? "generation-settings-error" : "generation-key-help"} aria-invalid={!!error}
                  className="w-full h-10 rounded-lg border border-border bg-secondary pl-3 pr-11 text-sm outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                />
                <button type="button" onClick={() => setShowKey(!showKey)} disabled={saving} aria-label={showKey ? "Hide API key" : "Show API key"} className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p id="generation-key-help" className="text-xs text-muted-foreground mt-2">{settings?.hasApiKey ? "Your current key stays active until the new one is checked." : "We’ll check your key before showing available models."}</p>
              <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground">
                <span>Get a key:</span>
                <button type="button" onClick={() => void ipc.app.OpenExternalUrl({ url: "https://platform.openai.com/api-keys" }).catch(() => {})} className="underline underline-offset-4 hover:text-foreground">OpenAI</button>
                <button type="button" onClick={() => void ipc.app.OpenExternalUrl({ url: "https://openrouter.ai/keys" }).catch(() => {})} className="underline underline-offset-4 hover:text-foreground">OpenRouter</button>
              </div>
              {settings?.hasApiKey && <button type="button" disabled={saving} onClick={() => { setError(""); setStep("remove") }} className="mt-4 text-xs text-red-400 hover:text-red-300 disabled:opacity-50">Remove API key</button>}
            </div> : <>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label htmlFor="generation-model" className="text-sm font-medium">Model</label>
                  <button type="button" onClick={refresh} disabled={loading || saving} aria-label="Refresh models" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
                    <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                    {loading ? "Loading…" : "Refresh"}
                  </button>
                </div>
                <div className="relative">
                  <select
                    ref={modelInput} id="generation-model" value={draft.model}
                    disabled={loading || saving || !settings?.models.length}
                    onChange={(event) => {
                      const model = settings?.models.find((item) => item.id === event.target.value)
                      if (model) { setDraft(defaultsFor(model, draft.quality)); setError("") }
                    }}
                    className="w-full h-10 appearance-none rounded-lg border border-border bg-secondary pl-3 pr-10 text-sm outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                  >
                    {!selected && <option value={draft.model} disabled>{loading ? "Loading models…" : "Choose a model"}</option>}
                    {settings?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                  </select>
                  <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
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
            </>}
            {error && <p id="generation-settings-error" role="alert" className="text-xs text-red-400">{error}</p>}
          </div>
          <div className="flex items-center justify-between gap-3 px-5 pb-5">
            {step === "remove" ? <button ref={cancelRemoval} type="button" disabled={saving} onClick={() => { setError(""); setStep("key") }} className="h-9 px-3 rounded-lg text-xs bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50">Cancel</button>
              : step === "key" ? settings?.hasApiKey ? <button type="button" disabled={saving} onClick={() => { setApiKey(""); setShowKey(false); setError(settings.error); setStep("models") }} className="h-9 px-3 rounded-lg text-xs bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50">Back</button> : <span />
              : settings?.apiKeyRequired ? <button type="button" disabled={saving} onClick={editKey} className="h-9 px-3 rounded-lg text-xs bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50">API key</button> : <span />}
            <button type="submit" disabled={saving || (step === "remove" ? !settings?.hasApiKey : step === "key" ? !apiKey.trim() : loading || !selected)} className={`h-9 px-4 rounded-lg text-xs font-medium disabled:opacity-40 ${step === "remove" ? "bg-red-500 text-white hover:bg-red-600" : "bg-primary text-primary-foreground"}`}>
              {step === "remove" ? saving ? "Removing…" : "Remove key" : saving ? step === "key" ? "Checking…" : "Saving…" : step === "key" ? "Continue" : "Done"}
            </button>
          </div>
        </form>
      </dialog>, document.body
    )}
  </>
}
