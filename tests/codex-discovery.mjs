import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";
import { mainLoader } from "./helpers/load-main.mjs";

const bundled = (app) => path.join(app, "Contents/Resources/codex");
const packaged = (app) => path.join(app, "Contents/Resources/codex-cli/bin/codex");
const standard = bundled("/Applications/ChatGPT.app");
const home = "/Users/discovery-test";

function subject({ running = [], registered = [], files = {}, env = {}, platform = "darwin", failure, output } = {}) {
  const calls = [];
  const probes = [];
  const lookups = [];
  const array = (values) => ({ count: values.length, objectAtIndex: (i) => values[i] });
  const url = (value) => ({ path: value });
  const load = mainLoader({ env, platform, modules: {
    "node:os": { homedir: () => home },
    "node:child_process": {
      execFile(file, args, options, callback) {
        calls.push({ file, args, options });
        if (failure) { callback(failure); return; }
        if (output !== undefined) { callback(null, output, ""); return; }
        // Execute the production script against an isolated AppKit bridge.
        const context = vm.createContext({
          ObjC: { import: (name) => assert.equal(name, "AppKit"), unwrap: (value) => value },
          $: {
            NSRunningApplication: { runningApplicationsWithBundleIdentifier(id) {
              lookups.push(id);
              return array(running.map((value) => ({ bundleURL: value === null ? null : url(value) })));
            } },
            NSWorkspace: { sharedWorkspace: { URLsForApplicationsWithBundleIdentifier(id) {
              lookups.push(id);
              return array(registered.map(url));
            } } },
          },
        });
        vm.runInContext(args[3], context);
        callback(null, context.run(args.slice(4)), "");
      },
    },
    "node:fs/promises": {
      async stat(candidate) {
        probes.push(candidate);
        if (!files[candidate]) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { isFile: () => files[candidate] !== "directory" };
      },
      async access(candidate, mode) {
        assert.equal(mode, constants.X_OK);
        if (files[candidate] === "denied") throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    },
  } });
  return { ...load(path.resolve("src/main/lib/codex-discovery.ts")), load, calls, probes, lookups };
}

test("discovers a renamed, relocated running app before registered and standard installations", async () => {
  const app = "/Volumes/External Drive/AI tools/ChatGPT 'personal' ✨.app";
  const f = subject({ running: [app], registered: ["/Applications/ChatGPT.app"], files: {
    [bundled(app)]: "file", [standard]: "file",
  } });
  assert.equal(await f.findCodex(), bundled(app));
  assert.deepEqual(f.lookups, ["com.openai.codex", "com.openai.codex"]);
  assert.equal(f.calls[0].file, "/usr/bin/osascript");
  assert.deepEqual([...f.calls[0].args.slice(0, 3)], ["-l", "JavaScript", "-e"]);
  assert.equal(f.calls[0].options.shell, undefined);
});

test("discovers a registered app without requiring it to run", async () => {
  const app = "/Users/discovery-test/Downloads/ChatGPT 2.app";
  const f = subject({ registered: [app], files: { [bundled(app)]: "file" } });
  assert.equal(await f.findCodex(), bundled(app));
});

test("discovers the packaged CLI in running, registered, and standard app locations", async () => {
  for (const location of ["running", "registered", "standard"]) {
    const app = location === "standard" ? "/Applications/ChatGPT.app" : "/Volumes/AI apps/ChatGPT 'personal' ✨.app";
    const f = subject({ [location]: [app], files: { [packaged(app)]: "file" } });
    assert.equal(await f.findCodex(), packaged(app), location);
  }
});

test("tries both layouts of the preferred app before other installations", async () => {
  const app = "/Volumes/AI apps/ChatGPT.app";
  const f = subject({ running: [app], registered: [app, "/Applications/ChatGPT.app"], files: {
    [packaged(app)]: "file", [bundled(app)]: "file", [standard]: "file",
  } });
  assert.deepEqual([...await f.findCodexCandidates()], [packaged(app), bundled(app), standard]);
  assert.equal(f.probes.filter((candidate) => candidate === packaged(app)).length, 1);
});

test("an explicitly selected app restricts both candidates to that bundle", async () => {
  const app = "/manual/ChatGPT.app";
  const f = subject({ registered: ["/Applications/ChatGPT.app"], env: { MOICONS_CODEX_PATH: "/custom/codex" }, files: {
    [packaged(app)]: "file", [bundled(app)]: "file", [standard]: "file", "/custom/codex": "file",
  } });
  assert.deepEqual([...await f.findCodexCandidates(app)], [packaged(app), bundled(app)]);
  assert.deepEqual([...await f.findCodexCandidates("/missing/ChatGPT.app")], []);
  assert.equal(f.calls.length, 0);
});

test("skips stale, inaccessible, and directory candidates to find another registered installation", async () => {
  const apps = ["/stale/ChatGPT.app", "/denied/ChatGPT.app", "/directory/ChatGPT.app", "/working/ChatGPT.app"];
  const f = subject({ running: [null, apps[0]], registered: apps, files: {
    [bundled(apps[1])]: "denied", [bundled(apps[2])]: "directory", [bundled(apps[3])]: "file",
  } });
  assert.equal(await f.findCodex(), bundled(apps[3]));
  assert.equal(f.probes.filter((candidate) => candidate === bundled(apps[0])).length, 1);
});

test("retains all four standard application locations when discovery finds no usable app", async () => {
  for (const root of ["/Applications", path.join(home, "Applications")]) {
    for (const name of ["ChatGPT.app", "Codex.app"]) {
      for (const layout of [bundled, packaged]) {
        const candidate = layout(path.join(root, name));
        const f = subject({ registered: ["/stale/ChatGPT.app"], files: { [candidate]: "file" } });
        assert.equal(await f.findCodex(), candidate);
      }
    }
  }
});

test("registry failure and timeout preserve filesystem discovery", async () => {
  for (const failure of [new Error("osascript unavailable"), Object.assign(new Error("timed out"), { killed: true })]) {
    const f = subject({ failure, files: { [standard]: "file" } });
    assert.equal(await f.findCodex(), standard);
    assert.ok(f.calls[0].options.timeout > 0 && f.calls[0].options.timeout <= 3000);
    assert.ok(f.calls[0].options.maxBuffer <= 64 * 1024);
  }
});

test("invalid registry output cannot break or redirect fallback discovery", async () => {
  for (const output of ["not json", "null", "{}", '[null,42,{},"relative/ChatGPT.app"]']) {
    const f = subject({ output, files: { [standard]: "file" } });
    assert.equal(await f.findCodex(), standard);
    assert.ok(f.probes.every(path.isAbsolute));
  }
});

test("retains PATH lookup and each common CLI location with a sparse Finder PATH", async () => {
  for (const directory of ["/custom/bin", "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local/bin")]) {
    const executable = path.join(directory, "codex");
    const f = subject({ env: { PATH: "/custom/bin:/usr/bin:/bin" }, files: { [executable]: "file" } });
    assert.equal(await f.findCodex(), executable);
  }
});

test("relative PATH entries and directories named codex are never selected", async () => {
  const f = subject({ env: { PATH: "relative/bin:/bad/bin:/good/bin" }, files: {
    "relative/bin/codex": "file", "/bad/bin/codex": "directory", "/good/bin/codex": "file",
  } });
  assert.equal(await f.findCodex(), "/good/bin/codex");
  assert.ok(!f.probes.includes("relative/bin/codex"));
});

test("explicit executable override stays authoritative and bypasses macOS discovery", async () => {
  for (const override of ["/custom/codex", "/missing/codex", "relative/codex"]) {
    const f = subject({ env: { MOICONS_CODEX_PATH: override }, files: {
      "/custom/codex": "file", "relative/codex": "file", [standard]: "file",
    } });
    assert.equal(await f.findCodex(), override === "/custom/codex" ? override : undefined);
    assert.equal(f.calls.length, 0);
  }
});

test("non-macOS systems use fallback paths without starting osascript", async () => {
  const f = subject({ platform: "linux", env: { PATH: "/custom/bin" }, files: { "/custom/bin/codex": "file" } });
  assert.equal(await f.findCodex(), "/custom/bin/codex");
  assert.equal(f.calls.length, 0);
});

test("check again discovers an app installed or moved since the previous check", async () => {
  const registered = [];
  const files = {};
  const f = subject({ registered, files });
  assert.equal(await f.findCodex(), undefined);
  registered.push("/new/ChatGPT.app");
  files[bundled(registered[0])] = "file";
  assert.equal(await f.findCodex(), bundled(registered[0]));
  delete files[bundled(registered[0])];
  registered[0] = "/moved/ChatGPT.app";
  files[bundled(registered[0])] = "file";
  assert.equal(await f.findCodex(), bundled(registered[0]));
});

test("account status delegates discovery and startup fallback to the client", async () => {
  const app = "/custom/ChatGPT.app";
  const f = subject({ registered: [app], files: { [bundled(app)]: "file" } });
  const { CodexClient } = f.load(path.resolve("src/main/lib/codex-client.ts"));
  let disposed = false;
  let starts = 0;
  CodexClient.start = async (executable) => {
    assert.equal(executable, undefined);
    starts++;
    return {
      request: async (method) => { assert.equal(method, "account/read"); return { account: { type: "chatgpt" } }; },
      dispose: async () => { disposed = true; },
    };
  };
  const account = f.load(path.resolve("src/main/lib/codex-account.ts"));
  assert.equal((await account.getCodexStatus()).state, "ready");
  assert.equal(starts, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(disposed, true);
});

test("real filesystem validation accepts executable symlinks and rejects non-executable files and directories", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "moicons-discovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "binary");
  const link = path.join(dir, "codex");
  await writeFile(binary, "fixture", { mode: 0o700 });
  await symlink(binary, link);
  const load = (override) => mainLoader({ env: { MOICONS_CODEX_PATH: override } })(path.resolve("src/main/lib/codex-discovery.ts"));
  assert.equal(await load(link).findCodex(), link);
  await chmod(binary, 0o600);
  assert.equal(await load(link).findCodex(), undefined);
  assert.equal(await load(dir).findCodex(), undefined);
});

test("real macOS registry discovers a renamed app outside standard installation folders", { skip: process.platform !== "darwin" }, async (t) => {
  const run = promisify(execFile);
  // Launch Services excludes /tmp from registration; keep this fixture in the
  // project's ignored build directory and unregister it before deleting it.
  await mkdir(path.resolve(".mobrowser"), { recursive: true });
  const root = await mkdtemp(path.resolve(".mobrowser/discovery-fixture-"));
  const app = path.join(root, "Renamed ChatGPT 'test' ✨.app");
  const bundleId = `com.moicons.discovery.test.${path.basename(root).toLowerCase()}`;
  const registryTool = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  t.after(async () => {
    try { await run(registryTool, ["-u", app], { timeout: 5000 }); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
  await mkdir(path.join(app, "Contents/Resources"), { recursive: true });
  await writeFile(path.join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>placeholder</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleName</key><string>Discovery test</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`);
  await copyFile("/usr/bin/true", path.join(app, "Contents/MacOS/placeholder"));
  await copyFile("/usr/bin/true", bundled(app));
  await run(registryTool, ["-f", app], { timeout: 5000 });
  let registeredPaths = [];
  const load = mainLoader({ env: { PATH: "/usr/bin:/bin" }, modules: {
    "node:child_process": { execFile(file, args, options, callback) {
      // Run the real discovery script with an isolated ID, without touching the
      // user's ChatGPT registration or starting any application.
      return execFile(file, [...args.slice(0, -1), bundleId], options, (error, stdout, stderr) => {
        if (!error) registeredPaths = JSON.parse(stdout);
        callback(error, stdout, stderr);
      });
    } },
  } });
  assert.equal(await load(path.resolve("src/main/lib/codex-discovery.ts")).findCodex(), bundled(app));
  assert.ok(registeredPaths.includes(app));
});
