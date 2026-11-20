#!/usr/bin/env node
// Local protocol fixture: no network or actual generation.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const scenario = process.env.MOICONS_TEST_SCENARIO || "success";
const log = (value) => appendFileSync(process.env.MOICONS_TEST_LOG, JSON.stringify(value) + "\n");
log({ envKeys: ["OPENAI_API_KEY", "CODEX_API_KEY"].filter((key) => process.env[key]), args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH });
const send = (message) => {
  const line = JSON.stringify(message) + "\n";
  // Exercise chunked JSON, not just one data event per message.
  process.stdout.write(line.slice(0, 13));
  process.stdout.write(line.slice(13));
};
const event = (method, params) => send({ method, params });
let threads = 0;
let completeAfterApproval;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  const { id, method, params } = message;
  if (id === "server-request" && !method && completeAfterApproval) {
    const complete = completeAfterApproval;
    completeAfterApproval = undefined;
    complete();
    return;
  }
  const reply = (result) => send({ id, result });
  if (method === "initialize") {
    if (scenario === "start-crash") process.exit(1);
    if (scenario === "start-hang") return;
    if (scenario === "start-malformed") { process.stdout.write("not-json\n"); return; }
    if (scenario === "old") send({ id, error: { code: -32601, message: "private server detail" } });
    else reply({});
  }
  if (method === "account/read") {
    if (scenario === "old-account" || scenario === "account-error") send({ id, error: { code: scenario === "old-account" ? -32601 : -32000, message: "private server detail" } });
    else reply({ account: scenario === "api" ? { type: "apiKey" } :
      scenario.startsWith("login") && !existsSync(process.env.MOICONS_TEST_LOG + ".signed-in") ? null : { type: "chatgpt", email: "test@example.com" } });
  }
  if (method === "config/read") reply({ config: { mcp_servers: { test: { enabled: true } } } });
  if (method === "thread/start") reply({ thread: { id: `thread-${++threads}` } });
  if (method === "turn/start") {
    const turnId = `turn-${threads}`;
    const threadId = params.threadId;
    const reference = params.input.find((item) => item.type === "localImage");
    if (reference) log({ referenceExists: existsSync(reference.path), referenceMatches: readFileSync(reference.path).toString("base64") === png });
    const references = params.input.filter(item => item.type === "localImage");
    if (references.length > 1) log({ referenceImages: references.map(item => ({ path: item.path, data: readFileSync(item.path).toString("base64") })) });
    event("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    // Events can arrive before the start response.
    if (scenario === "crash") { process.exit(1); }
    if (scenario === "wait") { reply({ turn: { id: turnId } }); return; }
    const complete = () => {
      if (scenario.startsWith("turn-") || scenario === "retry-then-success") {
        const error = scenario === "turn-outdated" ? {
          message: JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error",
            message: "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." } }),
          codexErrorInfo: "other",
        } : { message: "private server detail", codexErrorInfo: {
          "turn-limit": "usageLimitExceeded", "turn-rate-limit": "rateLimitExceeded",
          "turn-unauthorized": "unauthorized", "turn-model": "modelNotFound",
        }[scenario] || "other" };
        if (scenario !== "turn-error-only" && scenario !== "turn-failed-empty") {
          event("error", { threadId, turnId, error, willRetry: scenario === "retry-then-success" });
        }
        if (scenario !== "retry-then-success") {
          event("turn/completed", { threadId, turn: { id: turnId, status: scenario === "turn-interrupted" ? "interrupted" : "failed",
            error: ["turn-notification-only", "turn-failed-empty"].includes(scenario) ? null : error } });
          reply({ turn: { id: turnId } });
          return;
        }
      }
      if (scenario !== "empty") {
        const limited = scenario === "limit" || (scenario === "partial" && threads === 2);
        event("item/completed", { threadId, item: { id: "image", type: "imageGeneration", status: limited ? "failed" : "completed",
          result: scenario === "invalid" ? "not-an-image" : png, failure: limited ? { type: "usageLimitExceeded" } : null } });
      }
      event("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
      reply({ turn: { id: turnId } });
    };
    if (scenario === "approval") {
      completeAfterApproval = complete;
      send({ id: "server-request", method: "item/commandExecution/requestApproval", params: {} });
    } else {
      complete();
    }
  }
  if (method === "turn/interrupt") reply({});
  if (method === "account/login/start") {
    reply({ type: "chatgpt", loginId: "test-login", authUrl: "https://auth.openai.com/authorize?test=1" });
    if (scenario === "login-success") setTimeout(() => {
      writeFileSync(process.env.MOICONS_TEST_LOG + ".signed-in", "yes");
      event("account/login/completed", { loginId: "test-login", success: true });
    }, 100);
  }
  if (method === "account/login/cancel") reply({});
});
