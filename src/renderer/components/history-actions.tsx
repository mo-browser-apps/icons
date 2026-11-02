import { ContextMenu } from "@base-ui/react/context-menu"
import { Copy, Download, FolderOpen, Pencil, Trash2 } from "lucide-react"
import type { ReactNode } from "react"
import type { IconHistoryEntry } from "@/gen/app"

export type HistoryAction = "edit" | "save" | "reveal" | "copy" | "remove"
const actions = [
  { action: "edit", label: "Continue editing", Icon: Pencil },
  { action: "save", label: "Save as…", Icon: Download },
  { action: "reveal", label: "Show in Finder", Icon: FolderOpen },
  { action: "copy", label: "Copy prompt", Icon: Copy },
  { action: "remove", label: "Remove from history…", Icon: Trash2 },
] as const

function Items({ entry, onAction, busy }: {
  entry: IconHistoryEntry; onAction: (action: HistoryAction, entry: IconHistoryEntry) => void
  busy: boolean
}) {
  return <>{actions.map(({ action, label, Icon }) => <ContextMenu.Item
    key={action} className={`history-menu-item ${action === "remove" ? "history-menu-danger" : ""}`}
    disabled={busy || (action === "reveal" && !entry.exportPath)} onClick={() => onAction(action, entry)}
  ><Icon size={14} />{label}</ContextMenu.Item>)}</>
}

export function HistoryActions({ entry, onAction, children, busy = false }: {
  entry: IconHistoryEntry; onAction: (action: HistoryAction, entry: IconHistoryEntry) => void
  children: ReactNode; busy?: boolean
}) {
  const props = { entry, onAction, busy }
  return <ContextMenu.Root>
    <ContextMenu.Trigger className="history-thumb-shell">
      {children}
    </ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Positioner className="z-[80]">
      <ContextMenu.Popup className="history-menu"><Items {...props} /></ContextMenu.Popup>
    </ContextMenu.Positioner></ContextMenu.Portal>
  </ContextMenu.Root>
}
