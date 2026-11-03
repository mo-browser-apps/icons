import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { codexExecutablePath, getCodexAppPath } from "./codex-location";

export const fallbackBinPaths = ["/opt/homebrew/bin", "/usr/local/bin", path.join(homedir(), ".local/bin")];

// The unified ChatGPT app retains the Codex bundle identifier. Query AppKit
// directly through the system JXA bridge; this does not send Apple Events to apps.
const discoveryScript = `
ObjC.import("AppKit");
function run(argv) {
  const bundleId = argv[0];
  const paths = [];
  const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
  for (let i = 0; i < running.count; i++) {
    const url = running.objectAtIndex(i).bundleURL;
    if (ObjC.unwrap(url)) paths.push(ObjC.unwrap(url.path));
  }
  const registered = $.NSWorkspace.sharedWorkspace.URLsForApplicationsWithBundleIdentifier(bundleId);
  for (let i = 0; i < registered.count; i++) {
    paths.push(ObjC.unwrap(registered.objectAtIndex(i).path));
  }
  return JSON.stringify(paths);
}
`;

async function discoverAppBundles(): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("/usr/bin/osascript",
        ["-l", "JavaScript", "-e", discoveryScript, "com.openai.codex"],
        { encoding: "utf8", timeout: 3_000, maxBuffer: 64 * 1024 },
        (error, output) => error ? reject(error) : resolve(output));
    });
    const paths: unknown = JSON.parse(stdout);
    return Array.isArray(paths) ? paths.filter((value): value is string =>
      typeof value === "string" && path.isAbsolute(value)) : [];
  } catch {
    // A missing, blocked, or unresponsive registry must not disable path discovery.
    return [];
  }
}

async function executableFile(candidate: string): Promise<boolean> {
  if (!path.isAbsolute(candidate)) return false;
  try {
    // X_OK also succeeds for searchable directories; only launch regular files.
    if (!(await stat(candidate)).isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch { return false; }
}

export async function findCodexCandidates(): Promise<string[]> {
  // A location explicitly chosen in the UI takes priority over every other source.
  // An unavailable override must not silently select a different installation.
  const appPath = getCodexAppPath();
  const override = appPath ? codexExecutablePath(appPath) : process.env.MOICONS_CODEX_PATH;
  if (override) return await executableFile(override) ? [override] : [];

  const bundles = await discoverAppBundles();
  const candidates = [
    ...bundles.map(codexExecutablePath),
    ...["/Applications", path.join(homedir(), "Applications")].flatMap((root) =>
      ["ChatGPT.app", "Codex.app"].map((app) => path.join(root, app, "Contents/Resources/codex"))),
    // Finder-launched apps usually have a much smaller PATH than a terminal.
    ...[...(process.env.PATH || "").split(path.delimiter), ...fallbackBinPaths]
      .filter(Boolean).map((dir) => path.join(dir, "codex")),
  ];
  const available: string[] = [];
  for (const candidate of new Set(candidates)) if (await executableFile(candidate)) available.push(candidate);
  return available;
}

export async function findCodex(): Promise<string | undefined> {
  return (await findCodexCandidates())[0];
}
