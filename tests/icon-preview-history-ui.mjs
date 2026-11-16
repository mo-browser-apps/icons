// Run against `npm run dev -- --automation` with no preview open.
// Uses in-memory History fixtures; no provider calls, settings changes, or disk writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const agent = (...args) => JSON.parse(execFileSync('npm', ['--silent', 'run', 'mobrowser', '--', 'agent', ...args], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000,
}));
const evaluate = (fn, ...args) => agent('eval', `(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`).value;
const click = selector => agent('click', '--selector', selector);
const wait = selector => agent('wait-for', '--selector', selector, '--timeout', '10000');
const windows = () => agent('list-windows').windows;
function select(kind) {
  const view = windows().find(view => kind === 'image' ? view.url.startsWith('moicons-preview:')
    : kind === 'toolbar' ? view.url.endsWith('#icon-preview-toolbar')
      : !view.url.includes('#') && !view.url.startsWith('moicons-preview:'));
  assert.ok(view, `${kind} view exists`);
  agent('select-window', '--index', String(view.index));
  return view.id;
}
function until(condition, message) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (condition()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  }
  assert.fail(message);
}
function closePreview() {
  select('toolbar');
  try { click('[aria-label="Close preview"]'); }
  catch (error) { assert.match(String(error.stdout) + String(error.stderr), /window closed/); }
  until(() => windows().length === 1, 'preview closes');
  select('main');
}
const editorState = () => evaluate(() => ({
  prompt: document.querySelector('textarea')?.value,
  selected: document.querySelector('[aria-pressed="true"][aria-label^="Variant "]')?.getAttribute('aria-label') ?? null,
}));
const pixel = () => evaluate(() => {
  const image = document.querySelector('#icon');
  if (!image?.complete || image.naturalWidth !== 1024) return null;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  return [...context.getImageData(0, 0, 1, 1).data].join(',');
});

assert.equal(windows().length, 1, 'Close any preview before running this check.');
select('main'); wait('textarea');
evaluate(() => {
  document.querySelector('[aria-label="Close generation settings"]')?.click();
  document.querySelector('[aria-label="Close history"]')?.click();
  return true;
});
const before = editorState();
evaluate(async () => {
  const url = performance.getEntriesByType('resource').find(entry => entry.name.includes('/gen/ipc.ts')).name;
  const { ipc } = await import(url);
  const images = ['#ff0000', '#0000ff'].map(color => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 1024, 1024);
    return canvas.toDataURL();
  });
  const entries = images.map((thumbnail, variantIndex) => ({
    id: `preview-fixture-${variantIndex}`, generationId: 'preview-fixture', prompt: 'Preview reuse fixture',
    createdAt: new Date().toISOString(), variantIndex, thumbnail, exportPath: '', parentId: '',
  }));
  window.__previewHistoryTest = { ipc, list: ipc.app.ListIconHistory, get: ipc.app.GetIconHistory };
  ipc.app.ListIconHistory = async () => ({ entries, hasMore: false, warning: '' });
  ipc.app.GetIconHistory = async ({ id }) => {
    const entry = entries.find(entry => entry.id === id);
    return { entry, rawPng: images[entry.variantIndex], preparedPng: images[entry.variantIndex] };
  };
  return true;
});

try {
  click('button:has(svg.lucide-history)'); wait('.history-thumbnail');
  click('.history-thumbnail'); wait('[aria-label="Preview history icon"]');
  click('[aria-label="Preview history icon"]');
  until(() => windows().length === 3, 'History preview opens');
  const imageId = select('image');
  until(() => pixel() === '255,0,0,255', 'first variant artwork loads');
  const toolbarId = select('toolbar');

  // Change source, return to the first source, then reopen that same source.
  for (const index of [1, 0, 0]) {
    select('main'); click(`.history-variant-tabs button:nth-child(${index + 1})`);
    until(() => evaluate(() => document.querySelector('.history-variant-tabs [aria-pressed="true"]')?.textContent) === `Variant ${index + 1}`, 'History selects the next variant');
    assert.equal(evaluate(() => document.querySelector('[aria-label="Preview history icon"]').disabled), false, 'Preview remains available while its window is open');
    click('[aria-label="Preview history icon"]');
    assert.equal(select('toolbar'), toolbarId, 'reuse the toolbar');
    until(() => evaluate(() => document.querySelector('.preview-title > span').textContent) === `Variant ${index + 1}`, 'viewer title follows the requested variant');
    assert.equal(select('image'), imageId, 'reuse the image view');
    until(() => pixel() === (index === 1 ? '0,0,255,255' : '255,0,0,255'), 'viewer displays the requested artwork');
    assert.equal(windows().length, 3, 'only one preview window exists');
  }
  closePreview();
  until(() => evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Preview history icon', 'focus returns to the latest opener');
  click('[aria-label="Close history"]');
  assert.deepEqual(editorState(), before, 'previewing preserves the editor');
  console.log('PASS: History switches previews in both directions, reopens the same icon, and restores focus without changing the editor');
} finally {
  if (windows().length > 1) closePreview();
  select('main');
  evaluate(() => {
    document.querySelector('[aria-label="Close history"]')?.click();
    const test = window.__previewHistoryTest;
    test.ipc.app.ListIconHistory = test.list; test.ipc.app.GetIconHistory = test.get;
    delete window.__previewHistoryTest;
    return true;
  });
}
