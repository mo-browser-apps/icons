import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

// Run actual main-process modules with isolated preferences and HTTP.
export function mainLoader({ prefs, fetch, env = {} }) {
  const cache = new Map();
  return function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const source = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (id) => id === "@mobrowser/api" ? { prefs }
      : id.startsWith(".") ? load(path.resolve(path.dirname(file), id + ".ts")) : require(id);
    vm.runInNewContext(`(function(require, module, exports) {${source}\n})`, {
      Buffer, URL, Error, process: { env }, console, fetch, AbortSignal, AbortController,
      setTimeout: (callback, delay) => setTimeout(callback, delay <= 2000 ? 0 : delay),
      clearTimeout,
    })(localRequire, module, module.exports);
    return module.exports;
  };
}
