import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ArrowLeft, Check, ChevronDown, ChevronRight, ExternalLink, Eye, EyeOff, KeyRound, RefreshCw, Settings2, Sparkles, X } from "lucide-react"
import { ipc } from "@/gen/ipc"
import type { CodexStatus, GetGenerationSettingsResponse, ImageModelOption } from "@/gen/app"

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

const needsConnection = (settings: GetGenerationSettingsResponse) => !settings.ready
type Step = "connection" | "codex" | "key" | "models" | "remove"

export function GenerationSettings({ disabled, connectionRequest, onReadyChange }: {
  disabled: boolean
  connectionRequest: number
  onReadyChange: (ready: boolean) => void
}) {
  const [settings, setSettings] = useState<GetGenerationSettingsResponse | null>(null)
  const [draft, setDraft] = useState({ model: "", quality: "" })
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>("connection")
  const [codex, setCodex] = useState<CodexStatus | null>(null)
  const [checkingCodex, setCheckingCodex] = useState(false)
  const [isSetupFlow, setIsSetupFlow] = useState(false)
  const [keyBackStep, setKeyBackStep] = useState<"connection" | "models">("connection")
  const [modelsBackStep, setModelsBackStep] = useState<"connection" | "key">("key")
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const codexSelected = settings?.provider === "codex"
  const codexConnected = codexSelected && settings.ready && codex?.state === "ready" && settings.codex?.email === codex.email
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
      onReadyChange(response.ready)
      if (needsConnection(response)) { setIsSetupFlow(true); setStep(response.provider === "codex" ? "codex" : "connection"); setOpen(true) }
    }).catch(() => {
      if (version === requestVersion.current) {
        setError("Could not load generation settings. Try again.")
        onReadyChange(false)
      }
    }).finally(() => { if (version === requestVersion.current) setLoading(false) })
    return () => { requestVersion.current++ }
  }, [onReadyChange])

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
    if (connectionRequest) { setIsSetupFlow(true); setStep("connection"); setError(""); setOpen(true) }
  }, [connectionRequest])

  useEffect(() => {
    if (open) {
      dialog.current?.showModal()
      if (step === "key") keyInput.current?.focus()
      else if (step === "remove") cancelRemoval.current?.focus()
      else if (step === "models") modelInput.current?.focus()
      else dialog.current?.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus()
    } else dialog.current?.close()
  }, [open, step])

  const applySettings = (response: GetGenerationSettingsResponse) => {
    setSettings(response)
    setDraft(savedDraft(response))
    setError(response.error)
    onReadyChange(response.ready)
  }
  const chooseConnection = () => {
    requestVersion.current++
    setIsSetupFlow(true)
    setLoading(false)
    setError("")
    setApiKey("")
    setShowKey(false)
    setStep("connection")
  }
  const chooseApi = async () => {
    if (saving) return
    setKeyBackStep("connection")
    setModelsBackStep("connection")
    if (!settings?.hasApiKey) { editKey(); return }
    setSaving(true)
    setError("")
    try {
      const response = await ipc.app.SetGenerationConnection({ connection: "api" })
      applySettings(response)
      setStep(response.ready ? "models" : "key")
    } catch {
      setStep("key")
      setError("Could not connect with the saved API key. Check it or add a new key.")
    } finally { setSaving(false) }
  }
  const checkCodex = useCallback(async (quiet = false) => {
    const version = ++requestVersion.current
    if (!quiet) setCheckingCodex(true)
    setError("")
    try {
      const response = await ipc.app.GetCodexStatus({})
      if (version !== requestVersion.current) return
      setCodex(response)
      setError(response.state === "update_required" ? "" : response.error)
      return response
    } catch {
      if (version === requestVersion.current) {
        setCodex({ state: "error", email: "", error: "" })
        setError("Could not check the ChatGPT connection. Try again.")
      }
    } finally { if (version === requestVersion.current) setCheckingCodex(false) }
  }, [])
  useEffect(() => {
    if (!open || step !== "codex") return
    setCodex(null)
    void checkCodex()
    return () => { requestVersion.current++; void ipc.app.CancelCodexLogin({}).catch(() => {}) }
  }, [open, step, checkCodex])
  useEffect(() => {
    if (!open || step !== "codex") return
    const onFocus = () => {
      if (!saving && !checkingCodex && codex?.state !== "waiting") void checkCodex()
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [open, step, saving, checkingCodex, codex?.state, checkCodex])
  useEffect(() => {
    if (!open || step !== "codex" || codex?.state !== "waiting") return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const response = await checkCodex(true)
      if (!stopped && response?.state === "waiting") timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 2000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [open, step, codex?.state, checkCodex])
  useEffect(() => {
    if (codexSelected && codex) onReadyChange(!!codexConnected)
  }, [codexSelected, codex, codexConnected, onReadyChange])
  const cancelLogin = async () => {
    setSaving(true)
    try { await ipc.app.CancelCodexLogin({}); await checkCodex() }
    catch { setError("Could not cancel sign-in. Close this window and try again.") }
    finally { setSaving(false) }
  }
  const codexAction = async () => {
    if (saving || checkingCodex || !codex) return
    if (codexConnected) { close(); return }
    if (codex.state === "waiting") return
    if (codex.state === "error") { await checkCodex(); return }
    setSaving(true)
    setError("")
    try {
      if (codex.state === "not_installed" || codex.state === "update_required") {
        await ipc.app.OpenExternalUrl({ url: "https://learn.chatgpt.com/docs/app" })
      } else if (codex.state === "ready") {
        const response = await ipc.app.SetGenerationConnection({ connection: "codex" })
        applySettings(response)
        if (response.ready) { setOpen(false); trigger.current?.focus() }
      } else {
        const response = await ipc.app.StartCodexLogin({})
        setCodex(response)
        setError(response.state === "update_required" ? "" : response.error)
      }
    } catch { setError("Could not connect to ChatGPT. Check your sign-in and try again.") }
    finally { setSaving(false) }
  }
  const disconnectCodex = async () => {
    if (saving || !codexSelected) return
    requestVersion.current++
    setSaving(true)
    setError("")
    try {
      applySettings(await ipc.app.SetGenerationConnection({ connection: "none" }))
      chooseConnection()
    } catch { setError("Could not disconnect from MōIcons. Try again.") }
    finally { setSaving(false) }
  }

  const codexTitle = checkingCodex ? "Checking ChatGPT…"
    : codex?.state === "ready" ? codexConnected ? "Connected to MōIcons" : "ChatGPT account found"
    : codex?.state === "waiting" ? "Finish signing in"
    : codex?.state === "not_installed" ? "Install ChatGPT to continue"
    : codex?.state === "update_required" ? "Update ChatGPT to continue"
    : codex?.state === "error" ? "Could not connect to ChatGPT"
    : "Sign in to ChatGPT"
  const codexDescription = checkingCodex ? "Looking for the ChatGPT desktop app and your saved sign-in."
    : codex?.state === "ready" ? codex.email || "Your ChatGPT account"
    : codex?.state === "waiting" ? "Complete sign-in in your browser. This screen will update automatically."
    : codex?.state === "not_installed" ? "Install the ChatGPT desktop app. We’ll check again when you return here."
    : codex?.state === "update_required" ? "Get the latest ChatGPT desktop app. We’ll check again when you return."
    : codex?.state === "error" ? "Check that the ChatGPT desktop app opens on this Mac, then try again."
    : "Continue in your browser to sign in with your ChatGPT account."
  const codexActionLabel = checkingCodex || !codex ? "Checking…"
    : codexConnected ? "Done"
    : codex.state === "ready" ? "Use this account"
    : codex.state === "not_installed" ? "Install ChatGPT"
    : codex.state === "update_required" ? "Update ChatGPT"
    : codex.state === "error" ? "Try again"
    : codex.state === "waiting" ? "Waiting for sign-in…" : "Sign in with ChatGPT"

  const selected = settings?.models.find((model) => model.id === draft.model)
  const current = settings?.models.find((model) => model.id === settings.model)
  // Model results are only returned after the provider accepts the saved key.
  const canRemoveKey = !!settings?.apiKeyRequired && settings.hasApiKey &&
    settings.models.length > 0 && !settings.error
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
      setIsSetupFlow(needsConnection(settings))
      setStep(settings.provider === "codex" ? "codex" : needsConnection(settings) ? "connection" : "models")
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
      onReadyChange(response.ready)
      if (needsConnection(response)) {
        setIsSetupFlow(true)
        setKeyBackStep("connection")
        setStep(response.provider === "codex" ? "codex" : "key")
      }
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
      onReadyChange(true)
      setApiKey("")
      setShowKey(false)
      setModelsBackStep("key")
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
    if (saving || !settings || !canRemoveKey) return
    const version = ++requestVersion.current
    setSaving(true)
    setError("")
    try {
      const response = await ipc.app.RemoveApiKey({})
      if (version !== requestVersion.current) return
      if (response.error) { setError(response.error); return }
      setSettings({ ...settings, hasApiKey: false, ready: false, models: [], error: "", errorCode: "" })
      setDraft({ model: "", quality: "" })
      setApiKey("")
      setShowKey(false)
      onReadyChange(false)
      setIsSetupFlow(true)
      setStep("connection")
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
      title={codexSelected || !settings?.ready ? "Generation connection and settings" : "Model and effort"}
      aria-label="Generation settings"
      className="flex items-center gap-1.5 h-8 max-w-56 px-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors disabled:opacity-50"
    >
      <Settings2 className="w-4 h-4 shrink-0" />
      <span className="truncate text-xs">{settings?.provider === "codex" ? "ChatGPT" : settings && needsConnection(settings) ? "Connect to generate" : current?.name || settings?.model || "Generation settings"}</span>
    </button>
    {createPortal(
      <dialog
        ref={dialog}
        aria-labelledby="generation-settings-title"
        aria-describedby={step === "models" ? undefined : "generation-settings-description"}
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
            <h2 id="generation-settings-title" className="text-base font-medium">{step === "connection" ? "Connect to generate" : step === "codex" ? "ChatGPT" : step === "remove" ? "Remove API key?" : step === "key" ? "API key" : "Generation settings"}</h2>
            <button type="button" onClick={close} disabled={saving} aria-label="Close generation settings" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-secondary disabled:opacity-50">
              <X className="w-4 h-4" />
            </button>
          </div>
          {step !== "models" && <p id="generation-settings-description" className="text-xs text-muted-foreground mt-1">{step === "connection"
            ? "Choose how MōIcons generates your icons." : step === "codex"
            ? "Generate with your ChatGPT account through the desktop app." : step === "remove"
            ? "Remove the saved key from MōIcons." : "Connect OpenAI or OpenRouter to generate icons."}</p>}
        </div>
        <form onSubmit={(event) => {
          event.preventDefault()
          if (step === "codex") void codexAction()
          else if (step === "remove") void removeKey()
          else if (step === "key") void checkKey()
          else void save()
        }} aria-busy={saving || loading}>
          <div className="px-5 py-5 space-y-4">
            {step === "connection" ? <div className="space-y-3">
              <button type="button" data-autofocus disabled={saving} onClick={() => { setError(""); setStep("codex") }} className="group flex w-full items-center gap-3 rounded-xl border border-border bg-secondary/30 p-4 text-left transition-colors hover:border-primary/50 hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Sparkles className="h-5 w-5" /></span>
                <span className="flex-1"><span className="text-sm font-medium">ChatGPT</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">Use your ChatGPT account through the desktop app. No API key needed.</span></span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
              <button type="button" onClick={() => void chooseApi()} disabled={saving} className="group flex w-full items-center gap-3 rounded-xl border border-border bg-secondary/30 p-4 text-left transition-colors hover:border-primary/50 hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground"><KeyRound className="h-5 w-5" /></span>
                <span className="flex-1"><span className="text-sm font-medium">API key</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">Connect OpenAI or OpenRouter.<br />Usage is billed by your provider.</span></span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
              <p className="pt-1 text-center text-xs text-muted-foreground">You can change this in generation settings anytime.</p>
            </div> : step === "codex" ? <div className="space-y-4">
              <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-xl border border-border bg-secondary/40 p-4">
                <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${codexConnected ? "bg-emerald-500/10 text-emerald-400" : "bg-secondary text-muted-foreground"}`}>
                  {checkingCodex || codex?.state === "waiting" ? <RefreshCw className="h-4 w-4 animate-spin" /> : codexConnected ? <Check className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                </span>
                <div className="min-w-0"><p className="text-sm font-medium">{codexTitle}</p>
                  <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{codexDescription}</p>
                </div>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">Generation uses your plan’s allowance and available credits. Usage starts when you press Generate.</p>
              {codexConnected && <p className="text-xs leading-relaxed text-muted-foreground">ChatGPT chooses the image model and quality. Each generation creates up to three variants.</p>}
              {!codexConnected && <div className="flex items-center gap-4 text-xs">
                <button type="button" disabled={saving || checkingCodex || codex?.state === "waiting"} onClick={() => void checkCodex()} className="text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-40">Check again</button>
                {codex?.state === "waiting" && <button type="button" disabled={saving} onClick={() => void cancelLogin()} className="text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-40">Cancel sign-in</button>}
              </div>}
              {codexSelected && <div className="border-t border-border pt-3">
                <button type="button" disabled={saving || checkingCodex} onClick={() => void disconnectCodex()} className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-40">Disconnect from MōIcons</button>
                <p className="mt-1 text-xs text-muted-foreground">Your account stays signed in to ChatGPT.</p>
              </div>}
            </div> : step === "remove" ? <p className="text-sm text-muted-foreground">You’ll need to add an API key to generate icons again. Your model and effort choices will be kept.</p> : step === "key" ? <div>
              <label htmlFor="generation-api-key" className="sr-only">{settings?.hasApiKey ? "New API key" : "API key"}</label>
              <div className="relative">
                <input
                  ref={keyInput} id="generation-api-key" type={showKey ? "text" : "password"}
                  value={apiKey} onChange={(event) => { setApiKey(event.target.value); setError("") }}
                  placeholder="Your API key" disabled={saving}
                  autoComplete="off" autoCapitalize="none" spellCheck={false}
                  aria-describedby={error ? "generation-settings-error" : undefined} aria-invalid={!!error}
                  className="w-full h-10 rounded-lg border border-border bg-secondary pl-3 pr-11 text-sm outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                />
                <button type="button" onClick={() => setShowKey(!showKey)} disabled={saving} aria-label={showKey ? "Hide API key" : "Show API key"} className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {canRemoveKey && <button type="button" disabled={saving} onClick={() => { setError(""); setStep("remove") }} className="mt-4 text-xs text-red-400 hover:text-red-300 disabled:opacity-50">Remove API key</button>}
            </div> : <>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label htmlFor="generation-model" className="text-sm font-medium">{settings?.provider === "openrouter" ? "OpenRouter model" : settings?.provider === "openai" ? "OpenAI model" : "Model"}</label>
                  <button type="button" onClick={refresh} disabled={loading || saving} aria-label="Refresh models" title={loading ? "Loading models…" : "Refresh models"} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50">
                    <RefreshCw aria-hidden="true" className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
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
                <legend className="text-sm font-medium mb-2">Effort</legend>
                <div className="flex flex-wrap gap-1 rounded-lg bg-secondary/60 p-1">
                  {selected.qualities.map((quality) => <button
                    key={quality} type="button" aria-pressed={draft.quality === quality}
                    onClick={() => { setDraft({ ...draft, quality }); setError("") }}
                    className={`flex-1 py-1.5 px-2 rounded-md text-xs transition-colors ${draft.quality === quality ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >{label(quality)}</button>)}
                </div>
                <p className="text-xs text-muted-foreground mt-2">{draft.quality === "auto" ? "The model chooses the effort automatically." : "Higher effort can take longer and cost more."}</p>
              </fieldset>}
            </>}
            {error && <p id="generation-settings-error" role="alert" className="text-xs text-red-400">{error}</p>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-5">
            {step === "connection" ? <span /> : step === "codex" ? <button type="button" disabled={saving} onClick={chooseConnection} className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" />{codexSelected ? "Change method" : "Back"}</button> : step === "remove" ? <button ref={cancelRemoval} type="button" disabled={saving} onClick={() => { setError(""); setStep("key") }} className="h-9 px-3 rounded-lg text-xs bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50">Cancel</button>
              : step === "key" ? <div className="flex items-center gap-1">
                <button type="button" onClick={() => void ipc.app.OpenExternalUrl({ url: "https://platform.openai.com/api-keys" }).catch(() => {})} className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">OpenAI <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => void ipc.app.OpenExternalUrl({ url: "https://openrouter.ai/keys" }).catch(() => {})} className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">OpenRouter <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></button>
              </div>
              : settings?.apiKeyRequired ? <div className="flex gap-1">
                <button type="button" disabled={saving} onClick={() => {
                  if (isSetupFlow && modelsBackStep === "connection") { chooseConnection(); return }
                  if (!isSetupFlow) setKeyBackStep("models")
                  editKey()
                }} className="h-9 px-3 rounded-lg text-xs bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50">{isSetupFlow ? "Back" : "Change API key"}</button>
                {!isSetupFlow && <button type="button" disabled={saving} onClick={chooseConnection} className="h-9 px-3 rounded-lg text-xs text-muted-foreground hover:text-foreground">Change method</button>}
              </div> : <span />}
            {step !== "connection" && <div className="ml-auto flex items-center gap-2">
              {step === "key" && <button type="button" disabled={saving} onClick={() => {
                if (keyBackStep !== "models" || !settings?.ready || settings.provider === "codex") { chooseConnection(); return }
                setApiKey(""); setShowKey(false); setError(settings.error); setStep("models")
              }} className="h-9 px-3 rounded-lg text-xs bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50">Back</button>}
              <button type="submit" data-autofocus={step === "codex" || undefined} disabled={saving || (step === "codex" ? checkingCodex || !codex || codex.state === "waiting" : step === "remove" ? !canRemoveKey : step === "key" ? !apiKey.trim() : loading || !selected)} className={`h-9 px-4 rounded-lg text-xs font-medium disabled:opacity-40 ${step === "remove" ? "bg-red-500 text-white hover:bg-red-600" : "bg-primary text-primary-foreground"}`}>
                {step === "codex" ? saving ? "Please wait…" : codexActionLabel : step === "remove" ? saving ? "Removing…" : "Remove key" : saving ? step === "key" ? "Checking…" : "Saving…" : step === "key" ? "Continue" : "Done"}
              </button>
            </div>}
          </div>
        </form>
      </dialog>, document.body
    )}
  </>
}
