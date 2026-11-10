/** True when generation settings offer a useful way to recover. */
export function generationErrorSuggestsConnectionIssue(message: string): boolean {
  const m = message.toLowerCase()
  if (m.includes("codex") || m.includes("chatgpt")) return true
  if (m.includes("key cannot access gemini")) return true
  if (/\b401\b/.test(m) || /\b403\b/.test(m)) {
    return true
  }
  if (m.includes("invalid_api_key")) {
    return true
  }
  if (m.includes("incorrect api key")) {
    return true
  }
  if (m.includes("invalid bearer")) {
    return true
  }
  if (m.includes("unauthorized")) {
    return true
  }
  if (m.includes("authentication") && m.includes("openai")) {
    return true
  }
  if (
    m.includes("api key") &&
    (m.includes("invalid") ||
      m.includes("rejected") ||
      m.includes("incorrect") ||
      m.includes("expired") ||
      m.includes("revoked") ||
      m.includes("not found"))
  ) {
    return true
  }
  return false
}
