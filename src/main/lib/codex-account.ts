import { CodexClient, CodexCompatibilityError, findCodex } from "./codex-client";

export interface CodexStatus {
  state: "not_installed" | "update_required" | "signed_out" | "waiting" | "ready" | "error";
  email: string;
  error: string;
}
export interface CodexAccount { account: { type: string; email?: string } | null }
let login: { client: CodexClient; id: string; timer: ReturnType<typeof setTimeout>; unsubscribe: () => void } | undefined;
let starting: { client?: CodexClient } | undefined;
let loginError = "";

export async function getCodexStatus(): Promise<CodexStatus> {
  if (starting || login) return { state: "waiting", email: "", error: "" };
  if (!await findCodex()) return { state: "not_installed", email: "", error: "" };
  let client: CodexClient | undefined;
  try {
    client = await CodexClient.start();
    const { account } = await client.request<CodexAccount>("account/read", { refreshToken: false });
    if (account?.type === "chatgpt") loginError = "";
    return { state: account?.type === "chatgpt" ? "ready" : "signed_out", email: account?.type === "chatgpt" ? account.email || "" : "", error: loginError };
  } catch (error) {
    return { state: error instanceof CodexCompatibilityError ? "update_required" : "error", email: "", error: error instanceof Error ? error.message : "Could not connect to ChatGPT." };
  } finally { await client?.dispose(); }
}

export async function cancelCodexLogin() {
  loginError = "";
  const pendingStart = starting;
  starting = undefined;
  const pending = login;
  login = undefined;
  await pendingStart?.client?.dispose();
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.unsubscribe();
  try { await pending.client.request("account/login/cancel", { loginId: pending.id }, 3_000); }
  catch { /* Closing the private session also stops its login callback listener. */ }
  finally { await pending.client.dispose(); }
}

export async function startCodexLogin(openUrl: (url: string) => void): Promise<CodexStatus> {
  if (starting || login) return { state: "waiting", email: "", error: "" };
  const attempt: { client?: CodexClient } = {};
  starting = attempt;
  loginError = "";
  let client: CodexClient | undefined;
  try {
    client = await CodexClient.start();
    attempt.client = client;
    if (starting !== attempt) {
      await client.dispose();
      return { state: "signed_out", email: "", error: "" };
    }
    const response = await client.request<{ type: string; authUrl: string; loginId: string }>("account/login/start", { type: "chatgpt" });
    if (starting !== attempt) {
      await client.dispose();
      return { state: "signed_out", email: "", error: "" };
    }
    const url = new URL(response.authUrl);
    if (response.type !== "chatgpt" || url.protocol !== "https:" || !["auth.openai.com", "auth0.openai.com", "auth.chatgpt.com"].includes(url.hostname)) {
      throw new Error("ChatGPT returned an unsupported sign-in link. Update the ChatGPT desktop app and try again.");
    }
    const finish = (error = "") => {
      const current = login;
      if (!current || current.client !== client) return;
      login = undefined;
      loginError = error;
      clearTimeout(current.timer);
      current.unsubscribe();
      void current.client.dispose();
    };
    const unsubscribe = client.subscribe((event) => {
      if (event.method === "account/login/completed" && event.params.loginId === response.loginId) {
        finish(event.params.success ? "" : "Sign-in did not finish. Try signing in again.");
      }
    }, () => finish("The connection to ChatGPT was lost. Try signing in again."));
    login = { client, id: response.loginId, unsubscribe,
      timer: setTimeout(() => finish("Sign-in timed out. Try signing in again."), 5 * 60_000) };
    openUrl(url.href);
    return { state: "waiting", email: "", error: "" };
  } catch (error) {
    if (starting !== attempt) {
      await client?.dispose();
      return { state: "signed_out", email: "", error: "" };
    }
    if (login?.client === client) await cancelCodexLogin();
    else await client?.dispose();
    return { state: error instanceof CodexCompatibilityError ? "update_required" : "error", email: "", error: error instanceof Error ? error.message : "Could not start sign-in." };
  } finally { if (starting === attempt) starting = undefined; }
}
