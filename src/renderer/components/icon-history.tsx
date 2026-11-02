import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Download, FolderOpen, History, X } from "lucide-react"
import { ipc } from "@/gen/ipc"
import type { GetIconHistoryResponse, IconHistoryEntry } from "@/gen/app"
import { HistoryActions, type HistoryAction } from "./history-actions"
import "./icon-history.css"

function dayLabel(value: string) {
  const date = new Date(value), today = new Date(), yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return "Today"
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined })
}

function RemoveDialog({ entry, onCancel, onRemove, busy }: {
  entry: IconHistoryEntry; onCancel: () => void; onRemove: () => void; busy: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="history-remove" aria-labelledby="remove-history-title"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}>
    <h2 id="remove-history-title">Remove this icon from history?</h2>
    <p>Variant {entry.variantIndex + 1} will be removed from this Mac’s history. Exported files will stay where you saved them.</p>
    <div className="history-remove-actions">
      <button className="history-button" onClick={onCancel} disabled={busy} autoFocus>Cancel</button>
      <button className="history-button history-destructive" onClick={onRemove} disabled={busy}>{busy ? "Removing…" : "Remove icon"}</button>
    </div>
  </dialog>
}

export function IconHistory({ onClose, onContinue, onSave, onRemoved, revision }: {
  onClose: () => void; onContinue: (icon: GetIconHistoryResponse) => void
  onSave: (id: string) => Promise<void>; onRemoved: (id: string) => void; revision: number
}) {
  const [entries, setEntries] = useState<IconHistoryEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [detail, setDetail] = useState<GetIconHistoryResponse | null>(null)
  const [removing, setRemoving] = useState<IconHistoryEntry | null>(null)
  const request = useRef(0)
  const offset = useRef(0)
  const closeButton = useRef<HTMLButtonElement>(null)

  const load = async (append = false) => {
    const current = ++request.current
    setLoading(true)
    setError("")
    try {
      const result = await ipc.app.ListIconHistory({ offset: append ? offset.current : 0 })
      if (current !== request.current) return
      offset.current = (append ? offset.current : 0) + 8
      setEntries(previous => append ? [...previous, ...result.entries] : result.entries)
      setHasMore(result.hasMore)
      setError(result.warning)
    } catch { if (current === request.current) setError("History couldn’t be loaded. Try again.") }
    finally { if (current === request.current) setLoading(false) }
  }
  useEffect(() => {
    void load()
    return () => { request.current++ }
  }, [revision]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { closeButton.current?.focus() }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || removing || busy || document.querySelector('[role="menu"]')) return
      if (detail) setDetail(null)
      else onClose()
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [detail, removing, busy, onClose])

  const open = async (entry: IconHistoryEntry) => {
    setBusy(true); setError(""); setNotice("")
    try { setDetail(await ipc.app.GetIconHistory({ id: entry.id })) }
    catch { setError("This icon couldn’t be opened. Its files may have been moved or deleted.") }
    finally { setBusy(false) }
  }

  const action = async (action: HistoryAction, entry: IconHistoryEntry) => {
    if (busy) return
    if (action === "remove") { setRemoving(entry); return }
    setBusy(true); setError(""); setNotice("")
    try {
      if (action === "edit") onContinue(await ipc.app.GetIconHistory({ id: entry.id }))
      if (action === "save") {
        await onSave(entry.id)
        if (detail?.entry?.id === entry.id) setDetail(await ipc.app.GetIconHistory({ id: entry.id }))
        await load()
      }
      if (action === "reveal") await ipc.app.RevealIconHistoryExport({ id: entry.id })
      if (action === "copy") { await navigator.clipboard.writeText(entry.prompt); setNotice("Prompt copied") }
    } catch (error) { setError(error instanceof Error ? error.message : "That action couldn’t be completed. Try again.") }
    finally { setBusy(false) }
  }

  const remove = async () => {
    if (!removing) return
    setBusy(true)
    try {
      await ipc.app.RemoveIconHistory({ id: removing.id })
      onRemoved(removing.id)
      if (detail?.entry?.id === removing.id) setDetail(null)
      setRemoving(null)
      setNotice("Icon removed. Exported files were kept.")
      await load()
    } catch { setRemoving(null); setError("The icon couldn’t be removed. Try again.") }
    finally { setBusy(false) }
  }

  const groups = Array.from(new Set(entries.map(entry => entry.generationId))).map(id => entries.filter(entry => entry.generationId === id))
  const active = detail?.entry
  let previousDay = ""
  return <section className="history-panel" aria-label="Icon history">
    <header className="history-heading">
      {active ? <button className="history-back" onClick={() => { setDetail(null); setError(""); setNotice("") }}><ArrowLeft size={16} />All history</button>
        : <div><h1>History</h1><p>Generated icons, kept on this Mac.</p></div>}
      <button ref={closeButton} className="history-close" onClick={onClose} aria-label="Close history" disabled={busy}><X size={17} /></button>
    </header>
    <div className="history-scroll">
      {error && <div role="alert" className="history-error">{error}<button onClick={() => void load()} disabled={busy || loading}>Try again</button></div>}
      {loading && !entries.length && <p className="history-loading" role="status">Loading history…</p>}
      {!loading && !entries.length && !error && <div className="history-empty"><History size={30} strokeWidth={1.5} /><h2>Your next idea starts here</h2><p>Generate an icon and all its variants will appear here automatically.</p><button className="history-button history-primary" onClick={onClose}>Create an icon</button></div>}
      {active && detail ? <div className="history-detail">
        <div className="history-detail-preview"><HistoryActions entry={active} onAction={action} busy={busy}>
          <img src={detail.preparedPng} alt={`Variant ${active.variantIndex + 1}`} className="history-large-icon" />
        </HistoryActions></div>
        <div className="history-variant-tabs" aria-label="Variants from this generation">
          {entries.filter(entry => entry.generationId === active.generationId).map(entry => <button key={entry.id}
            aria-pressed={entry.id === active.id} disabled={busy} onClick={() => void open(entry)}>Variant {entry.variantIndex + 1}</button>)}
        </div>
        <p className="history-label">{active.parentId ? "Refinement prompt" : "Original prompt"}</p><p className="history-prompt">{active.prompt}</p>
        <p className="history-meta">{new Date(active.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}{active.exportPath ? ` · Exported as ${active.exportPath.split(/[\\/]/).pop()}` : " · Not exported"}</p>
        <div className="history-detail-buttons">
          {active.exportPath ? <button className="history-button" disabled={busy} onClick={() => void action("reveal", active)}><FolderOpen size={14} />Show in Finder</button>
            : <button className="history-button" disabled={busy} onClick={() => void action("save", active)}><Download size={14} />Save as…</button>}
          <button className="history-button history-primary" disabled={busy} onClick={() => void action("edit", active)}>Continue editing</button>
        </div>
      </div> : !detail && <div className="history-list">
        {groups.map(group => {
          const first = group[0], day = dayLabel(first.createdAt), showDay = day !== previousDay
          previousDay = day
          return <div key={first.generationId}>{showDay && <h2 className="history-date">{day}</h2>}
            <article className="history-row">
              <div className="history-thumbnails">{group.map(entry => <HistoryActions key={entry.id} entry={entry} onAction={action} busy={busy}>
                <button className="history-thumbnail" disabled={busy} aria-label={`Open ${entry.prompt}, variant ${entry.variantIndex + 1}`} onClick={() => void open(entry)}>
                  <img src={entry.thumbnail} alt="" draggable={false} />
                </button>
              </HistoryActions>)}</div>
              <div className="history-row-copy"><p className="history-row-prompt">{first.prompt}</p>
                <p className="history-meta">{new Date(first.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</p>
              </div>
            </article>
          </div>
        })}
        {hasMore && <button className="history-button history-more" disabled={loading || busy} onClick={() => void load(true)}>{loading ? "Loading…" : "Load older icons"}</button>}
      </div>}
    </div>
    <footer className="history-footer" aria-live="polite">{notice}</footer>
    {removing && <RemoveDialog entry={removing} onCancel={() => setRemoving(null)} onRemove={remove} busy={busy} />}
  </section>
}
