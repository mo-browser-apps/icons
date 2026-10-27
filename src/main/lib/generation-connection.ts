import { prefs } from "@mobrowser/api";

export const CONNECTION_PREF = "imageGeneration.connection";
export function usesCodex(): boolean { return prefs.getString(CONNECTION_PREF) === "codex"; }

export function isConnectionDisconnected(): boolean {
  const forced = process.env.ICON_PROVIDER?.trim();
  if (forced && ["codex", "openai", "openrouter", "mock"].includes(forced)) return false;
  return prefs.getString(CONNECTION_PREF) === "none";
}

export function saveConnection(connection: "codex" | "api" | "none") {
  const had = prefs.hasString(CONNECTION_PREF);
  const previous = prefs.getString(CONNECTION_PREF);
  prefs.setString(CONNECTION_PREF, connection);
  if (!prefs.persist()) {
    if (had) prefs.setString(CONNECTION_PREF, previous);
    else prefs.remove(CONNECTION_PREF);
    throw new Error("Could not save your connection. Try again.");
  }
}
