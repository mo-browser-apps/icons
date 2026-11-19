import { app, BaseWindow, BrowserView, BrowserWindow, ipc, protocol } from '@mobrowser/api';
import { EventEmitter, on } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PreviewServiceDescriptor } from '../gen/ipc_service';
import type { IconPreviewState } from '../gen/preview';
import imageDocument from './icon-preview-image.html?raw';

const TOOLBAR_HEIGHT = 84;
const MIN_ZOOM = 0.01;
const MIN_BROWSER_ZOOM = 0.25;
const MAX_ZOOM = 4;
const STEPS = [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** A separate browser origin keeps Chromium's host-scoped zoom out of the editor. */
export function registerIconPreview(owner: BrowserWindow) {
  let ownerClosed = false;
  let active: {
    window: BaseWindow; image: BrowserView; toolbar: BrowserView;
    png: Buffer; token: string; state: IconPreviewState; closed: Promise<void>;
  } | undefined;
  const events = new EventEmitter();
  const snapshot = (): IconPreviewState => active ? { ...active.state } : {
    title: '', factor: 1, fit: true, transparency: false, width: 0, height: 0, focusRequest: 0, focusLast: false,
  };
  const publish = () => events.emit('state', snapshot());
  const setFactor = (factor: number) => {
    if (!active || !Number.isFinite(factor)) return;
    active.state.factor = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor));
    // Chromium clamps page zoom at 25%. The image document supplies the
    // remaining scale for larger references without changing their pixels.
    active.image.browser.zoom.setFactor(Math.max(MIN_BROWSER_ZOOM, active.state.factor));
    publish();
  };
  const fit = () => {
    if (!active) return;
    active.state.fit = true;
    const { width, height } = active.image.bounds.size;
    setFactor(Math.min(1, (width - 48) / active.state.width, (height - 48) / active.state.height));
  };
  const layout = () => {
    if (!active) return;
    const { width, height } = active.window.contentView.bounds.size;
    active.toolbar.setBounds({ origin: { x: 0, y: 0 }, size: { width, height: TOOLBAR_HEIGHT } });
    active.image.setBounds({ origin: { x: 0, y: TOOLBAR_HEIGHT }, size: { width, height: Math.max(1, height - TOOLBAR_HEIGHT) } });
    if (active.state.fit) fit();
  };
  const command = (action: string, factor = 1) => {
    if (!active) return snapshot();
    if (action === 'close') { active.window.close(); return snapshot(); }
    if (action === 'toolbar' || action === 'toolbar-back') {
      active.state.focusRequest++;
      active.state.focusLast = action === 'toolbar-back';
      publish();
      active.toolbar.browser.focus();
      return snapshot();
    }
    if (action === 'image') { active.image.browser.focus(); return snapshot(); }
    if (action === 'fit' || action === 'ready') fit();
    else if (action === 'transparency') { active.state.transparency = !active.state.transparency; publish(); }
    else if (['in', 'out', 'actual', 'zoom'].includes(action)) {
      active.state.fit = false;
      const current = active.state.factor;
      const next = action === 'in' ? STEPS.find(value => value > current + 0.001) ?? MAX_ZOOM
        : action === 'out' ? [...STEPS].reverse().find(value => value < current - 0.001) ?? MIN_ZOOM
        : action === 'actual' ? 1 : factor;
      setFactor(next);
    }
    return snapshot();
  };

  protocol.handle('moicons-preview', async request => {
    const url = new URL(request.url);
    const current = active;
    if (!current || url.hostname !== 'image' || !url.pathname.startsWith(`/${current.token}/`)) {
      return { statusCode: 404, mimeType: 'text/plain', data: 'Preview closed' };
    }
    const resource = url.pathname.slice(current.token.length + 2);
    if (resource === '' && request.method === 'GET') {
      return { statusCode: 200, mimeType: 'text/html', charset: 'utf-8', data: imageDocument };
    }
    if (resource === 'image.png' && request.method === 'GET') {
      return { statusCode: 200, mimeType: 'image/png', data: current.png };
    }
    if (resource === 'state' && request.method === 'GET') {
      return { statusCode: 200, mimeType: 'application/json', data: JSON.stringify(snapshot()) };
    }
    // Only ephemeral viewer operations are exposed on this private, random path.
    // This runtime supports GET resource requests for custom schemes, not Fetch
    // or request bodies. Persistent app operations remain on typed app IPC.
    if (resource === 'command' && request.method === 'GET') {
      const action = url.searchParams.get('action') || '';
      const factor = Number(url.searchParams.get('factor') || 1);
      return { statusCode: 200, mimeType: 'application/json', data: JSON.stringify(command(action, factor)) };
    }
    return { statusCode: 404, mimeType: 'text/plain', data: 'Not found' };
  });

  ipc.registerService(PreviewServiceDescriptor, {
    async Open(request) {
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(request.png) || request.png.length > 32 * 1024 * 1024) {
        throw new Error('This icon could not be previewed.');
      }
      const png = Buffer.from(request.png.slice('data:image/png;base64,'.length), 'base64');
      if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid icon image.');
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      if (!width || !height || width > 8192 || height > 8192) throw new Error('Unsupported icon dimensions.');
      // Reuse one viewer; inspecting an icon never changes the selected variant.
      if (active) {
        active.png = png;
        active.token = randomUUID();
        active.state = { ...active.state, title: request.title || 'Icon preview', width, height, fit: true };
        active.window.setTitle(active.state.title);
        active.image.browser.loadUrl(`moicons-preview://image/${active.token}/`);
        fit(); publish();
        active.window.show(); active.window.focus();
        await active.closed;
        return {};
      }
      const window = new BaseWindow({ title: request.title || 'Icon preview', size: { width: 800, height: 740 }, minimumSize: { width: 460, height: 420 }, resizable: true });
      const token = randomUUID();
      const toolbar = new BrowserView({ url: `${app.url}#icon-preview-toolbar` });
      const image = new BrowserView({ url: `moicons-preview://image/${token}/` });
      let resolveClosed!: () => void;
      const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
      active = { window, toolbar, image, png, token, closed, state: {
        title: request.title || 'Icon preview', factor: 1, fit: true, transparency: false, width, height, focusRequest: 0, focusLast: false,
      } };
      window.contentView.addChildView(toolbar);
      window.contentView.addChildView(image);
      // Browser zoom is enabled only for the artwork. Toolbar uses the app origin.
      toolbar.browser.zoom.setEnabled(false);
      image.browser.zoom.on('factorChanged', factor => {
        if (!active || active.window !== window) return;
        // Our own native zoom notification must not replace a smaller image scale.
        if (Math.abs(factor - Math.max(MIN_BROWSER_ZOOM, active.state.factor)) < 0.001) return;
        active.state.factor = factor;
        publish();
      });
      window.on('resized', layout);
      window.on('closed', () => {
        active = undefined;
        resolveClosed();
        if (!ownerClosed) { owner.focus(); owner.browser.focus(); }
      });
      layout();
      window.centerWindow();
      window.show();
      window.focus();
      toolbar.browser.focus();
      await closed;
      return {};
    },
    async Command(request) { return command(request.action, request.factor); },
    async *Watch(_request, context) {
      const updates = on(events, 'state', { signal: context.signal });
      try {
        yield snapshot();
        for await (const [state] of updates) yield state as IconPreviewState;
      } catch (error) {
        if (!context.signal.aborted) throw error;
      } finally { await updates.return?.(); }
    },
  });
  owner.on('closed', () => { ownerClosed = true; active?.window.close(); });
  return {
    /** Route View menu actions to the image even when a toolbar button has focus. */
    zoom(action: 'in' | 'out' | 'actual' | 'fit') {
      if (!active?.window.isActive) return false;
      command(action);
      return true;
    },
  };
}
