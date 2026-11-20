import { createHash } from "node:crypto";
import { prefs } from "@mobrowser/api";
import { CodexClient } from "./codex-client";
import type { CodexAccount } from "./codex-account";

type Account = NonNullable<CodexAccount["account"]>;
export interface CodexModel {
  model: string;
  displayName: string;
  hidden?: boolean;
  isDefault?: boolean;
  inputModalities?: string[];
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string }[];
}

function selectionIdentity(account: Account): string | undefined {
  // Keep choices separate when accounts or plans change, without storing emails.
  if (!account.email) return undefined;
  const identity = JSON.stringify([account.email.trim().toLowerCase(), account.planType || "unknown"]);
  return createHash("sha256").update(identity).digest("hex");
}

function preferenceKey(account: Account): string | undefined {
  const identity = selectionIdentity(account);
  return identity ? `imageGeneration.codex.model.${identity}` : undefined;
}

export async function listCodexModels(client: CodexClient): Promise<CodexModel[]> {
  const models = new Map<string, CodexModel>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.request<{ data: CodexModel[]; nextCursor?: string | null }>("model/list", {
      modelProvider: "openai", includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}),
    });
    for (const model of page.data) {
      // Image input is needed for refinement. It does not guarantee image-tool access.
      if (model.model && !model.hidden && (!model.inputModalities || model.inputModalities.includes("image"))) {
        models.set(model.model, model);
      }
    }
    cursor = page.nextCursor || undefined;
    if (cursor && cursors.has(cursor)) throw new Error("Could not finish loading ChatGPT models. Try refreshing the list.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...models.values()];
}

export function selectCodexModel(models: CodexModel[], account: Account): CodexModel {
  const key = preferenceKey(account);
  const saved = key ? models.find((model) => model.model === prefs.getString(key)) : undefined;
  // Preserve the server's ordering within each family; never invent a model ID.
  const family = /^pro(?:$|lite$|_)/i.test(account.planType || "") ? "astra" : "sol";
  const preferred = models.find((model) => new RegExp(`^gpt-[\\d.]+-${family}$`).test(model.model));
  const selected = saved || preferred || models.find((model) => model.isDefault) || models[0];
  if (!selected) throw new Error("No compatible ChatGPT models were found. Update ChatGPT and refresh models, or choose an API key.");
  return selected;
}

export function codexModelConfig(model: CodexModel) {
  const efforts = model.supportedReasoningEfforts || [];
  const effort = efforts.find((item) => item.reasoningEffort === model.defaultReasoningEffort)?.reasoningEffort
    || efforts[0]?.reasoningEffort || model.defaultReasoningEffort || null;
  // Clear inherited effort/speed settings that may not work with this account/model.
  return { model_reasoning_effort: effort, service_tier: "default" };
}

async function withAccountModels<T>(email: string, read: (models: CodexModel[], account: Account) => T): Promise<T> {
  const client = await CodexClient.start();
  try {
    const { account } = await client.request<CodexAccount>("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt") throw new Error("Sign in with ChatGPT in generation settings to choose a model.");
    if ((account.email || "") !== email) throw new Error("Your ChatGPT account changed. Refresh generation settings before choosing a model.");
    return read(await listCodexModels(client), account);
  } finally { await client.dispose(); }
}

export async function readCodexModelSettings(email: string) {
  return withAccountModels(email, (models, account) => ({
    codexSelectionId: selectionIdentity(account) || "",
    model: selectCodexModel(models, account).model,
    models: models.map((model) => ({ id: model.model, name: model.displayName || model.model, qualities: [], maxReferenceImages: 2 })),
  }));
}

export async function saveCodexModel(model: string, email: string, expectedSelectionId: string): Promise<void> {
  await withAccountModels(email, (models, account) => {
    if (!expectedSelectionId || expectedSelectionId !== selectionIdentity(account)) {
      throw new Error("Your ChatGPT account or plan changed. Refresh generation settings before choosing a model.");
    }
    if (!models.some((item) => item.model === model)) throw new Error("The selected ChatGPT model is no longer listed. Refresh models and choose another.");
    const key = preferenceKey(account);
    if (!key) throw new Error("ChatGPT did not identify this account. Sign in again before saving a model.");
    const previous = prefs.getString(key);
    prefs.setString(key, model);
    if (!prefs.persist()) {
      if (previous) prefs.setString(key, previous);
      else prefs.remove(key);
      throw new Error("Could not save the ChatGPT model. Your previous choice has been kept.");
    }
  });
}
