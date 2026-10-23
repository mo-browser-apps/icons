import './sentry';
import { app, BrowserWindow, workspace, ipc, Menu, MenuItem, MenuWithRole, Theme } from '@mobrowser/api';
import { exec } from 'node:child_process';
import { preserveSmallIconAlpha } from './lib/icns-alpha';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  GenerateIconRequest,
  GenerateIconResponse,
  GetGenerationSettingsRequest,
  SetGenerationSettingsRequest,
  GetOpenAIApiKeyStatusRequest,
  GetOpenAIApiKeyStatusResponse,
  GetStoredOpenAIApiKeyRequest,
  GetStoredOpenAIApiKeyResponse,
  OpenExternalUrlRequest,
  PickReferenceImageRequest,
  PickReferenceImageResponse,
  SaveIconRequest,
  SaveIconResponse,
  SetOpenAIApiKeyRequest,
  SetOpenAIApiKeyResponse,
  SetThemeRequest,
  SetUnsavedIconStateRequest,
  ShowPathInFinderRequest,
} from './gen/app';
import { AppServiceDescriptor } from './gen/ipc_service';
import { buildPrompt } from './lib/prompt-builder';
import { getProvider, resolveProviderName } from './lib/image-provider';
import { getImageSettings, saveImageSettings } from './lib/generation-settings';
import { listImageModels, ProviderRequestError } from './lib/image-models';
import { removeStoredApiKey, saveValidatedApiKey } from './lib/api-key-settings';
import {
  getResolvedApiKey,
  hasApiKeyInPrefs,
} from './lib/openai-api-key';

// ---------------------------------------------------------------------------
// Icon resize constants
// ---------------------------------------------------------------------------

// The 10 required macOS icon sizes: [filename, pixel dimension].
const ICON_SIZES: [string, number][] = [
  ['icon_16x16.png',      16],
  ['icon_16x16@2x.png',   32],
  ['icon_32x32.png',      32],
  ['icon_32x32@2x.png',   64],
  ['icon_128x128.png',   128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png',   256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png',   512],
  ['icon_512x512@2x.png', 1024],
];

const GITHUB_REPOSITORY_URL = 'https://github.com/mo-browser-apps/icons';

function run(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => (err ? reject(err) : resolve()));
  });
}

/** Normalize save dialog output to .icns path and companion .iconset directory. */
function resolveSaveTargets(pickedPath: string): {
  parentDir: string;
  icnsPath: string;
  iconsetDir: string;
  baseName: string;
} {
  const resolved = path.resolve(pickedPath);
  const parentDir = path.dirname(resolved);
  let base = path.basename(resolved);
  const ext = path.extname(base);
  if (ext.toLowerCase() === '.icns') {
    base = path.basename(base, ext);
  }
  if (!base || base === '.' || base === '..') {
    base = 'App';
  }
  const icnsPath = path.join(parentDir, `${base}.icns`);
  const iconsetDir = path.join(parentDir, `${base}.iconset`);
  return { parentDir, icnsPath, iconsetDir, baseName: base };
}

async function icnsOutputsExist(icnsPath: string, iconsetDir: string): Promise<boolean> {
  try {
    await fs.access(icnsPath);
    return true;
  } catch {
    /* not found. */
  }
  try {
    const st = await fs.stat(iconsetDir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function removeIcnsOutputs(icnsPath: string, iconsetDir: string): Promise<void> {
  await fs.rm(iconsetDir, { recursive: true, force: true });
  await fs.unlink(icnsPath).catch(() => {});
}

/** Resize the finished preview PNG, preserving its transparent margins and shadow. */
async function buildIcnsAt(imageData: Buffer, iconsetDir: string, icnsPath: string): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moicons-'));
  const srcPng = path.join(tmp, 'icon_1024.png');
  await fs.writeFile(srcPng, Buffer.from(imageData));
  try {
    await fs.mkdir(iconsetDir, { recursive: true });
    for (const [name, size] of ICON_SIZES) {
      await run(
        `sips -z ${size} ${size} "${srcPng}" --out "${path.join(iconsetDir, name)}"`,
      );
    }
    await run(`iconutil -c icns "${iconsetDir}" --output "${icnsPath}"`);
    const [icns, png16, png32] = await Promise.all([
      fs.readFile(icnsPath),
      fs.readFile(path.join(iconsetDir, 'icon_16x16.png')),
      fs.readFile(path.join(iconsetDir, 'icon_32x32.png')),
    ]);
    await fs.writeFile(icnsPath, preserveSmallIconAlpha(icns, png16, png32));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function showAboutDialog() {
  const result = await app.showMessageDialog({
    parentWindow: win,
    type: 'info',
    message: `${app.name} ${app.version}`,
    informativeText: `${app.description}\n\nPowered by MōBrowser framework.\n\n${app.copyright}`,
    buttons: [
      { label: 'Close', type: 'primary' },
      { label: 'Open GitHub Repository...', type: 'secondary' },
    ],
  });
  if (result.button.type === 'secondary') {
    workspace.openUrl(GITHUB_REPOSITORY_URL);
  }
}

// Set the theme to dark by default.
app.setTheme('dark');

// ---------------------------------------------------------------------------
// Main App Menu
// ---------------------------------------------------------------------------

const macAppMenu = new MenuWithRole({
  role: 'macAppMenu',
  items: [
    new MenuItem({
      id: 'about',
      label: 'About ' + app.name,
      action: (_item: MenuItem) => {
        showAboutDialog();
      }
    }),
    'separator',
    'macHideApp',
    'macHideOthers',
    'macShowAll',
    'separator',
    'quit',
  ]
})

const fileMenu = new MenuWithRole({
  role: 'fileMenu',
  items: [
    'closeWindow',
  ]
})

const editMenu = new MenuWithRole({
  role: 'editMenu',
  items: [
    'undo',
    'redo',
    'separator',
    'cut',
    'copy',
    'paste',
    'pasteAndMatchStyle',
    'delete',
    'selectAll',
  ]
})

const viewMenu = new Menu({
  label: 'View',
  items: [
    'zoomReset',
    'zoomIn',
    'zoomOut',
    'separator',
    'fullScreen',
  ]
})

const windowMenu = new MenuWithRole({
  role: 'windowMenu',
  items: [
    'minimizeWindow',
  ]
})

const helpMenu = new MenuWithRole({
  role: 'helpMenu',
  items: [
    new MenuItem({
      id: 'openGitHub',
      label: 'Open GitHub Repository...',
      action: (_item: MenuItem) => {
        workspace.openUrl(GITHUB_REPOSITORY_URL);
      }
    }),
  ]
})

const appMenu = new Menu({
  items: [
    macAppMenu,
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ]
})
app.setMenu(appMenu)

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let hasUnsavedIcon = false;

// Create the main app window.
const win = new BrowserWindow({
  url: app.url,
  size: { width: 550, height: 520 },
  resizable: false,
  windowTitleVisible: false,
  windowTitlebarVisible: false,
  windowButtonPosition: { x: 20, y: 20 },
  windowButtonVisible: {
    maximize: false,
    zoom: false,
  }
});
win.centerWindow();
win.show();

win.handle('close', async () => {
  if (!hasUnsavedIcon) {
    return 'close';
  }
  const result = await app.showMessageDialog({
    parentWindow: win,
    type: 'warning',
    title: 'Quit without saving?',
    message:
      'Your icon has not been saved. If you quit now, it will be lost.',
    buttons: [
      { label: 'Cancel', type: 'secondary' },
      { label: 'Quit Anyway', type: 'primary' },
    ],
  });
  if (result.button.type === 'primary') {
    return 'close';
  }
  return 'cancel';
});

// ---------------------------------------------------------------------------
// IPC service
// ---------------------------------------------------------------------------

ipc.registerService(AppServiceDescriptor, {
  async GetApplicationMetadata() {
    return {
      name: app.name,
      version: app.version,
    };
  },

  async SetTheme(request: SetThemeRequest) {
    app.setTheme(request.theme as Theme);
    return {};
  },

  async SetUnsavedIconState(request: SetUnsavedIconStateRequest) {
    hasUnsavedIcon = request.unsaved;
    return {};
  },

  async SaveIcon(request: SaveIconRequest): Promise<SaveIconResponse> {
    let saveDialogDefault = path.join(app.getPath('userHome'), 'Desktop', 'app.icns');

    for (;;) {
      const pick = await app.showSaveDialog({
        parentWindow: win,
        title: 'Save icon',
        buttonLabelSave: 'Save',
        defaultPath: saveDialogDefault,
        filters: [{ name: 'macOS icon', extensions: ['icns'] }],
        features: { canCreateDirectories: true },
      });

      if (pick.canceled || !pick.path) {
        return { savedPath: '', canceled: true, icnsPath: '' };
      }

      const { parentDir, icnsPath, iconsetDir } = resolveSaveTargets(pick.path);

      if (await icnsOutputsExist(icnsPath, iconsetDir)) {
        const names = `${path.basename(icnsPath)}\n${path.basename(iconsetDir)}`;
        const confirm = await app.showMessageDialog({
          parentWindow: win,
          type: 'warning',
          title: 'Already exists',
          message:
            `A file or folder with this name is already in the destination folder:\n\n${names}\n\n` +
            'Replace them, or choose another name or folder.',
          buttons: [
            { label: 'Cancel', type: 'secondary' },
            { label: 'Choose Different…', type: 'regular' },
            { label: 'Replace', type: 'primary' },
          ],
        });

        if (confirm.button.type === 'primary') {
          await removeIcnsOutputs(icnsPath, iconsetDir);
          await buildIcnsAt(request.imageData, iconsetDir, icnsPath);
          hasUnsavedIcon = false;
          return { savedPath: parentDir, canceled: false, icnsPath };
        }
        if (confirm.button.type === 'regular') {
          saveDialogDefault = icnsPath;
          continue;
        }
        return { savedPath: '', canceled: true, icnsPath: '' };
      }

      await buildIcnsAt(request.imageData, iconsetDir, icnsPath);
      hasUnsavedIcon = false;
      return { savedPath: parentDir, canceled: false, icnsPath };
    }
  },

  async ShowPathInFinder(request: ShowPathInFinderRequest) {
    if (request.path) {
      workspace.showPath(request.path);
    }
    return {};
  },

  async OpenExternalUrl(request: OpenExternalUrlRequest) {
    const url = request.url.trim();
    if (url) {
      workspace.openUrl(url);
    }
    return {};
  },

  async PickReferenceImage(
    _request: PickReferenceImageRequest
  ): Promise<PickReferenceImageResponse> {
    // Use the native open dialog rather than an HTML <input type=file>: in
    // MoBrowser the native picker is the reliable way to choose a file from the
    // sandboxed renderer.
    const pick = await app.showOpenDialog({
      parentWindow: win,
      title: 'Choose reference image',
      buttonLabelOpen: 'Attach',
      selectionPolicy: 'files',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      ],
    });

    if (pick.canceled || pick.paths.length === 0) {
      return { imageB64: '', mime: '', canceled: true, error: '' };
    }

    try {
      const picked = pick.paths[0];
      const bytes = await fs.readFile(picked);
      const ext = path.extname(picked).toLowerCase();
      const mime =
        ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : 'image/png';
      return {
        imageB64: bytes.toString('base64'),
        mime,
        canceled: false,
        error: '',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { imageB64: '', mime: '', canceled: false, error: message };
    }
  },

  async GenerateIcon(request: GenerateIconRequest): Promise<GenerateIconResponse> {
    try {
      const { positive, negative } = buildPrompt(request.prompt);
      const result = await getProvider().generate({
        positivePrompt: positive,
        negativePrompt: negative,
        referenceImageB64: request.referenceImage || undefined,
        count: 3,
      });
      return { images: result.images, error: '' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { images: [], error: message };
    }
  },

  async GetOpenAIApiKeyStatus(
    _request: GetOpenAIApiKeyStatusRequest
  ): Promise<GetOpenAIApiKeyStatusResponse> {
    // A key is required for any real image provider (OpenAI or OpenRouter);
    // only the mock provider needs none.
    return {
      openaiKeyRequired: resolveProviderName() !== 'mock',
      hasOpenaiKey: hasApiKeyInPrefs(),
    };
  },

  async GetGenerationSettings(request: GetGenerationSettingsRequest) {
    const provider = resolveProviderName();
    const settings = getImageSettings(provider);
    const base = { provider, ...settings, hasApiKey: hasApiKeyInPrefs(), apiKeyRequired: provider !== 'mock' };
    if (base.apiKeyRequired && !base.hasApiKey) {
      return { ...base, models: [], error: '', errorCode: '' };
    }
    try {
      const models = await listImageModels(provider, getResolvedApiKey(), request.refresh);
      return { ...base, models, error: '', errorCode: '' };
    } catch (err) {
      return { ...base, models: [], error: err instanceof Error ? err.message : String(err),
        errorCode: err instanceof ProviderRequestError ? err.code : '' };
    }
  },

  async SetGenerationSettings(request: SetGenerationSettingsRequest) {
    try {
      const provider = resolveProviderName();
      if (request.provider !== provider) throw new Error('Your provider changed. Reopen generation settings.');
      await saveImageSettings(provider, getResolvedApiKey(), {
        model: request.model, quality: request.quality,
      });
      return { error: '' };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },

  async GetStoredOpenAIApiKey(
    _request: GetStoredOpenAIApiKeyRequest
  ): Promise<GetStoredOpenAIApiKeyResponse> {
    return { apiKey: getResolvedApiKey() };
  },

  async SetOpenAIApiKey(
    request: SetOpenAIApiKeyRequest
  ): Promise<SetOpenAIApiKeyResponse> {
    try {
      const settings = await saveValidatedApiKey(request.apiKey);
      return { error: '', settings };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Could not check the API key. Try again.', settings: undefined };
    }
  },

  async RemoveApiKey() {
    try {
      removeStoredApiKey();
      return { error: '' };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Could not remove the API key. Try again.' };
    }
  },
});
