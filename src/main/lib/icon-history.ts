import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

type VariantInput = { variantIndex: number; rawPng: string; preparedPng: string; thumbnailPng: string };
type GenerationInput = { generationId: string; prompt: string; parentId: string; variants: VariantInput[] };
type Variant = { variantIndex: number; exportPath: string };
type Manifest = { version: 1; generationId: string; prompt: string; parentId: string; createdAt: string; variants: Variant[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Page by complete generations so a three-variant group is never split.
const PAGE_SIZE = 8;

function imageBytes(value: string, maxBytes: number) {
  const base64 = value.replace(/^data:image\/png;base64,/, "");
  if (base64.length > Math.ceil(maxBytes * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("The icon image is invalid or too large to keep in history.");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length <= PNG.length || bytes.length > maxBytes || !bytes.subarray(0, 8).equals(PNG)) {
    throw new Error("History requires PNG artwork.");
  }
  return bytes;
}

function splitId(id: string) {
  const [generationId, slot, extra] = id.split(":");
  if (!UUID.test(generationId) || !/^[0-2]$/.test(slot ?? "") || extra !== undefined) {
    throw new Error("Invalid history icon.");
  }
  return { generationId, variantIndex: Number(slot) };
}

/** Local image files; a generation becomes visible only after its atomic rename. */
export class IconHistoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error("History needs an absolute data directory.");
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  private async manifest(generationId: string): Promise<Manifest> {
    if (!UUID.test(generationId)) throw new Error("Invalid history generation.");
    const value = JSON.parse(await fs.readFile(path.join(this.root, generationId, "manifest.json"), "utf8"));
    if (value.version !== 1 || value.generationId !== generationId || typeof value.prompt !== "string" ||
        typeof value.parentId !== "string" || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
        !Array.isArray(value.variants) || !value.variants.length || value.variants.length > 3 ||
        value.variants.some((v: Variant) => !v || !Number.isInteger(v.variantIndex) || v.variantIndex < 0 || v.variantIndex > 2 || typeof v.exportPath !== "string") ||
        new Set(value.variants.map((v: Variant) => v.variantIndex)).size !== value.variants.length) {
      throw new Error("This history entry could not be read.");
    }
    return value;
  }

  private async writeManifest(manifest: Manifest) {
    const directory = path.join(this.root, manifest.generationId);
    const temp = path.join(directory, `.manifest-${randomUUID()}`);
    try {
      await fs.writeFile(temp, JSON.stringify(manifest), { mode: 0o600 });
      await fs.rename(temp, path.join(directory, "manifest.json"));
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  private async entry(manifest: Manifest, variant: Variant) {
    const thumbnail = await fs.readFile(path.join(this.root, manifest.generationId, `${variant.variantIndex}-thumb.png`));
    return {
      id: `${manifest.generationId}:${variant.variantIndex}`,
      generationId: manifest.generationId, prompt: manifest.prompt, createdAt: manifest.createdAt,
      parentId: manifest.parentId, variantIndex: variant.variantIndex, exportPath: variant.exportPath,
      thumbnail: `data:image/png;base64,${thumbnail.toString("base64")}`,
    };
  }

  record(input: GenerationInput) {
    return this.serial(async () => {
      if (!UUID.test(input.generationId) || !input.prompt.trim() || input.prompt.length > 32000 ||
          !input.variants.length || input.variants.length > 3 ||
          new Set(input.variants.map(v => v.variantIndex)).size !== input.variants.length ||
          input.variants.some(v => !Number.isInteger(v.variantIndex) || v.variantIndex < 0 || v.variantIndex > 2)) {
        throw new Error("Invalid history generation.");
      }
      if (input.parentId) splitId(input.parentId);
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      // A retry after a lost IPC reply must not duplicate or overwrite history.
      let existing: Manifest | undefined;
      try { existing = await this.manifest(input.generationId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing) return Promise.all(existing.variants.map(v => this.entry(existing!, v)));

      const staging = path.join(this.root, `.pending-${randomUUID()}`);
      const manifest: Manifest = {
        version: 1, generationId: input.generationId, prompt: input.prompt.trim(), parentId: input.parentId,
        createdAt: new Date().toISOString(),
        variants: input.variants.map(v => ({ variantIndex: v.variantIndex, exportPath: "" })),
      };
      await fs.mkdir(staging, { mode: 0o700 });
      try {
        for (const variant of input.variants) {
          for (const [suffix, data, limit] of [
            ["raw", variant.rawPng, 32 * 1024 * 1024],
            ["prepared", variant.preparedPng, 32 * 1024 * 1024],
            ["thumb", variant.thumbnailPng, 512 * 1024],
          ] as const) {
            await fs.writeFile(path.join(staging, `${variant.variantIndex}-${suffix}.png`), imageBytes(data, limit), { mode: 0o600 });
          }
        }
        await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
        await fs.rename(staging, path.join(this.root, input.generationId));
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
      return Promise.all(manifest.variants.map(v => this.entry(manifest, v)));
    });
  }

  list(offset = 0) {
    return this.serial(async () => {
      let directories;
      try { directories = await fs.readdir(this.root, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], hasMore: false, warning: "" };
        throw error;
      }
      let skipped = 0;
      const manifests: Manifest[] = [];
      for (const dir of directories) {
        if (!dir.isDirectory() || !UUID.test(dir.name)) continue;
        try { manifests.push(await this.manifest(dir.name)); }
        catch { skipped++; }
      }
      manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.generationId.localeCompare(a.generationId));
      const start = Math.max(0, Math.floor(offset));
      const page = manifests.slice(start, start + PAGE_SIZE).flatMap(manifest => manifest.variants.map(variant => ({ manifest, variant })));
      const entries = [];
      for (const { manifest, variant } of page) {
        try { entries.push(await this.entry(manifest, variant)); }
        catch { skipped++; }
      }
      return { entries, hasMore: manifests.length > start + PAGE_SIZE,
        warning: skipped ? "Some history entries could not be loaded. Your other icons are still available." : "" };
    });
  }

  get(id: string) {
    return this.serial(async () => {
      const { generationId, variantIndex } = splitId(id);
      const manifest = await this.manifest(generationId);
      const variant = manifest.variants.find(v => v.variantIndex === variantIndex);
      if (!variant) throw new Error("This icon is no longer in history.");
      const [raw, prepared, entry] = await Promise.all([
        fs.readFile(path.join(this.root, generationId, `${variantIndex}-raw.png`)),
        fs.readFile(path.join(this.root, generationId, `${variantIndex}-prepared.png`)),
        this.entry(manifest, variant),
      ]);
      return { entry, rawPng: `data:image/png;base64,${raw.toString("base64")}`, preparedPng: `data:image/png;base64,${prepared.toString("base64")}` };
    });
  }

  setExportPath(id: string, exportPath: string) {
    return this.serial(async () => {
      const { generationId, variantIndex } = splitId(id);
      const manifest = await this.manifest(generationId);
      const variant = manifest.variants.find(v => v.variantIndex === variantIndex);
      if (!variant) throw new Error("This icon is no longer in history.");
      if (!path.isAbsolute(exportPath)) throw new Error("Invalid export location.");
      variant.exportPath = exportPath;
      await this.writeManifest(manifest);
    });
  }

  remove(id: string) {
    return this.serial(async () => {
      const { generationId, variantIndex } = splitId(id);
      const manifest = await this.manifest(generationId);
      manifest.variants = manifest.variants.filter(v => v.variantIndex !== variantIndex);
      const directory = path.join(this.root, generationId);
      if (!manifest.variants.length) {
        await fs.rm(directory, { recursive: true });
      } else {
        await this.writeManifest(manifest);
        await Promise.all(["raw", "prepared", "thumb"].map(suffix => fs.rm(path.join(directory, `${variantIndex}-${suffix}.png`), { force: true })));
      }
      // Exported .icns/.iconset files belong to the user and are never deleted.
    });
  }
}
