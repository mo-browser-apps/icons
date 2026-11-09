import { prefs } from "@mobrowser/api";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_PATH_PREF = "imageGeneration.chatgptAppPath";
export const codexExecutablePaths = (appPath: string) => [
  // Recent ChatGPT builds ship the CLI as a package with its own launcher.
  path.join(appPath, "Contents/Resources/codex-cli/bin/codex"),
  path.join(appPath, "Contents/Resources/codex"),
];
export const getCodexAppPath = () => prefs.getString(APP_PATH_PREF);

export async function executableFile(candidate: string): Promise<boolean> {
  if (!path.isAbsolute(candidate)) return false;
  try {
    // X_OK also succeeds for searchable directories; only launch regular files.
    if (!(await stat(candidate)).isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch { return false; }
}

export async function validateCodexAppPath(input: string): Promise<string> {
  let value = input.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (value.startsWith("file:")) {
    try { value = fileURLToPath(value); }
    catch { throw new Error("Enter a local path to the ChatGPT app, such as /Applications/ChatGPT.app."); }
  }
  if (value.startsWith("~/")) value = path.join(homedir(), value.slice(2));
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error("Enter the full path to your ChatGPT app, such as /Applications/ChatGPT.app.");
  const appPath = path.normalize(value).replace(/\/+$/, "");
  if (path.extname(appPath).toLowerCase() !== ".app") throw new Error("Choose the ChatGPT .app bundle, not a folder or a file inside it.");
  try {
    if (!(await stat(appPath)).isDirectory()) throw new Error();
  } catch { throw new Error("That app could not be found or accessed. Check its location in Finder and try again."); }
  for (const executable of codexExecutablePaths(appPath)) {
    if (await executableFile(executable)) return appPath;
  }
  throw new Error("This app does not contain a usable ChatGPT connection. Choose a current ChatGPT desktop app.");
}

export function persistCodexAppPath(appPath: string): void {
  const previous = getCodexAppPath();
  if (appPath) prefs.setString(APP_PATH_PREF, appPath);
  else prefs.remove(APP_PATH_PREF);
  if (!prefs.persist()) {
    if (previous) prefs.setString(APP_PATH_PREF, previous);
    else prefs.remove(APP_PATH_PREF);
    throw new Error("Could not save the app location. Your previous setting has been kept. Try again.");
  }
}
