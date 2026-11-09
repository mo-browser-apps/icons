import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { codexExecutablePaths, executableFile, getCodexAppPath } from "./codex-location";

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

export async function findCodexCandidates(appPath = getCodexAppPath()): Promise<string[]> {
  // A location explicitly chosen in the UI takes priority over every other source.
  // An unavailable override must not silently select a different installation.
  const override = appPath ? codexExecutablePaths(appPath)
    : process.env.MOICONS_CODEX_PATH ? [process.env.MOICONS_CODEX_PATH] : undefined;

  const bundles = override ? [] : await discoverAppBundles();
  const candidates = override ?? [
    ...bundles.flatMap(codexExecutablePaths),
    ...["/Applications", path.join(homedir(), "Applications")].flatMap((root) =>
      ["ChatGPT.app", "Codex.app"].flatMap((app) => codexExecutablePaths(path.join(root, app)))),
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
