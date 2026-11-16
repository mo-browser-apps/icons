// Run against `npm run dev -- --automation`. Uses fixture generation only;
// history and provider settings are not modified. No paid image requests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const output = path.resolve('.mobrowser/zoom-review');
mkdirSync(output, { recursive: true });
const agent = (...args) => JSON.parse(execFileSync('npm', ['--silent', 'run', 'mobrowser', '--', 'agent', ...args], { encoding: 'utf8', maxBuffer: 24 * 1024 * 1024, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }));
const evaluate = (fn, ...args) => agent('eval', `(${fn.toString()})(${args.map(x => JSON.stringify(x)).join(',')})`).value;
const click = selector => agent('click', '--selector', selector);
const wait = selector => agent('wait-for', '--selector', selector, '--timeout', '10000');
const windows = () => agent('list-windows').windows;
function select(kind) {
  const item = windows().find(w => kind === 'image' ? w.url.startsWith('moicons-preview:') : kind === 'toolbar' ? w.url.endsWith('#icon-preview-toolbar') : !w.url.includes('#') && !w.url.startsWith('moicons-preview:'));
  assert.ok(item, `${kind} view exists`);
  agent('select-window', '--index', String(item.index));
}
function until(fn, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (fn()) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60); }
  assert.fail(label);
}
const factor = () => evaluate(() => Number(document.querySelector('output')?.textContent.replace('%', '')));
function close() {
  select('toolbar');
  try { click('[aria-label="Close preview"]'); } catch (error) { assert.match(String(error.stdout) + String(error.stderr), /window closed/); }
  until(() => windows().length === 1, 'preview window closes'); select('main');
}
const state = () => evaluate(() => ({ prompt: document.querySelector('textarea')?.value, selected: document.querySelector('[aria-pressed="true"][aria-label^="Variant "]')?.getAttribute('aria-label') ?? null, dpr: devicePixelRatio, width: innerWidth }));
const screenshot = name => agent('screenshot', '--out', path.join(output, name));

// Agent commands do not expose trackpad/wheel input. Drive this same app's CDP
// target for a trusted wheel event; never launch an external browser.
async function wheel(parameters) {
  const targets = await (await fetch(`${process.env.MOICONS_CDP_URL || 'http://127.0.0.1:9222'}/json/list`)).json();
  const target = targets.find(t => t.url.startsWith('moicons-preview:'));
  assert.ok(target, 'existing image view has a debug target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => {socket.onopen=resolve;socket.onerror=reject;});
  try {
    await new Promise((resolve,reject) => {
      const timeout=setTimeout(()=>reject(new Error('Input timed out')),5000);
      socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id===1){clearTimeout(timeout);message.error?reject(new Error(message.error.message)):resolve();}};
      socket.send(JSON.stringify({id:1,method:'Input.dispatchMouseEvent',params:{type:'mouseWheel',x:300,y:250,deltaX:0,...parameters}}));
    });
  } finally {socket.close();}
}

if (windows().length > 1) close();
select('main'); evaluate(() => { location.reload(); return true; }); wait('textarea');
evaluate(async svg => {
  const url = performance.getEntriesByType('resource').find(e => e.name.includes('/gen/ipc.ts')).name;
  const { ipc } = await import(url);
  const source = new Image(); source.src = 'data:image/svg+xml;base64,' + btoa(svg); await source.decode();
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
  canvas.getContext('2d').drawImage(source, 0, 0);
  const png = canvas.toDataURL().split(',')[1];
  window.__previewTest = { ipc, generate: ipc.app.GenerateIcon, record: ipc.app.RecordIconHistory, calls:0 };
  ipc.app.GenerateIcon = async () => { window.__previewTest.calls++; return { images: [png,png,png], error:'' }; };
  ipc.app.RecordIconHistory = async () => ({ entries:[], hasMore:false, warning:'' });
  return true;
}, readFileSync('tests/fixtures/flower.svg', 'utf8'));

try {
  agent('fill', '--selector', 'textarea', '--value', 'A botanical icon for a quiet garden app');
  wait('[aria-label="Submit"]:not(:disabled)');
  click('[aria-label="Submit"]'); wait('[aria-label="Preview variant 3"]');
  assert.equal(evaluate(() => document.querySelectorAll('[aria-label^="Preview variant "]').length), 3);
  click('[aria-label="Variant 2"]');
  const before = state(); screenshot('three-variants.png');
  click('[aria-label="Preview variant 1"]');
  until(() => windows().length === 3, 'preview and toolbar open');
  select('toolbar'); wait('output'); until(() => factor() < 100 && factor() >= 25, 'opens fitted');
  const fitted = factor();
  const toolbarDpr = evaluate(() => devicePixelRatio);
  select('image'); wait('#icon');
  assert.equal(evaluate(() => document.querySelector('img').naturalWidth), 1024);
  assert.ok(evaluate(() => document.querySelector('img').getBoundingClientRect().width <= innerWidth && document.querySelector('img').getBoundingClientRect().height <= innerHeight));
  screenshot('image-fit.png');
  select('main'); assert.deepEqual(state(), before);
  console.log('PASS: three independent Preview actions; full image fits; selection and prompt untouched');

  select('toolbar'); click('button[title^="Actual size"]'); until(() => factor() === 100, '100%');
  click('[aria-label="Zoom in"]'); until(() => factor() === 125, 'zoom in');
  assert.equal(evaluate(() => devicePixelRatio), toolbarDpr, 'toolbar does not zoom');
  select('image');
  assert.ok(evaluate(() => document.querySelector('#viewport').scrollHeight > document.querySelector('#viewport').clientHeight));
  select('toolbar');
  agent('press-key','--selector','[aria-label="Close preview"]','--key','Tab');
  select('image');
  assert.equal(evaluate(()=>document.activeElement.id),'viewport','Tab enters scrollable image');
  const keyboardScrollBefore=evaluate(()=>document.querySelector('#viewport').scrollTop);
  agent('press-key', '--key', 'ArrowDown');
  until(()=>evaluate(()=>document.querySelector('#viewport').scrollTop)>keyboardScrollBefore,'arrow key actually pans');
  agent('press-key','--key','Tab');select('toolbar');
  until(()=>evaluate(()=>document.activeElement?.getAttribute('aria-label'))==='Zoom out','Tab returns to first control');
  agent('press-key','--key','Shift+Tab');select('image');agent('press-key','--key','Shift+Tab');select('toolbar');
  until(()=>evaluate(()=>document.activeElement?.getAttribute('aria-label'))==='Close preview','Shift-Tab returns to last control');
  select('toolbar'); click('[aria-label="Show transparency"]'); select('image'); wait('.checker'); screenshot('image-zoomed.png');
  select('main'); assert.deepEqual(state(), before);
  console.log('PASS: browser zoom affects artwork only; keyboard panning and transparency work');

  select('toolbar'); click('button[title^="Fit ("]'); until(() => factor() === fitted, 'Fit resets');
  agent('resize', '--width', '500', '--height', '460');
  until(() => factor() < fitted, 'Fit follows window resize');
  click('button[title^="Actual size"]'); until(() => factor() === 100, '100% in smaller window');
  agent('resize', '--width', '900', '--height', '780');
  assert.equal(factor(),100,'manual scale survives resize');
  select('image');
  evaluate(() => { document.querySelector('#viewport').addEventListener('wheel',e=>{window.__trustedPinch=e.isTrusted;},{once:true}); return true; });
  await wheel({deltaY:-30,modifiers:2});
  select('toolbar'); until(() => factor() > 100, 'pinch path changes browser zoom');
  select('image');assert.equal(evaluate(()=>window.__trustedPinch),true);
  assert.equal(evaluate(()=>visualViewport.scale),1,'pinch does not also magnify the browser viewport');
  const scrollBefore=evaluate(()=>document.querySelector('#viewport').scrollTop);
  await wheel({deltaY:90,modifiers:0});
  until(()=>evaluate(()=>document.querySelector('#viewport').scrollTop)>scrollBefore,'ordinary scrolling pans');
  select('toolbar');
  for(let i=0;i<15 && factor()<400;i++)click('[aria-label="Zoom in"]');
  assert.ok(evaluate(()=>document.querySelector('[aria-label="Zoom in"]').disabled));
  for(let i=0;i<15 && factor()>25;i++)click('[aria-label="Zoom out"]');
  assert.ok(evaluate(()=>document.querySelector('[aria-label="Zoom out"]').disabled));
  close(); assert.deepEqual(state(),before);
  until(()=>evaluate(()=>document.activeElement?.getAttribute('aria-label')==='Preview variant 1'),'focus returns to preview trigger');
  console.log('PASS: fit/manual resizing, pinch event, zoom bounds, close and focus restoration');

  click('[aria-label="Select"]'); wait('[aria-label="Preview icon"]');
  agent('fill','--selector','textarea','--value','Make the petals a warmer pink');
  const refinement = state();
  click('[aria-label="Preview icon"]'); until(()=>windows().length===3,'single-icon preview opens');
  select('toolbar'); until(()=>factor()<100,'single icon opens fitted');
  close(); assert.deepEqual(state(),refinement);
  screenshot('single-icon.png');
  console.log('PASS: selected icon opens the same viewer and retains refinement prompt');

  click('button:has(svg.lucide-history)'); wait('.history-thumbnail'); click('.history-thumbnail'); wait('[aria-label="Preview history icon"]');
  click('[aria-label="Preview history icon"]'); until(()=>windows().length===3,'history preview opens');
  select('image');wait('#icon');assert.equal(evaluate(()=>document.querySelector('img').naturalWidth),1024);
  close(); wait('.history-detail');click('[aria-label="Close history"]');
  assert.deepEqual(state(),refinement);
  assert.equal(evaluate(()=>window.__previewTest.calls),1);
  console.log('PASS: History previews its full-resolution image and returns to editing unchanged');
} finally {
  if(windows().length>1)close();
  select('main');
  evaluate(() => { const t=window.__previewTest; if(t){t.ipc.app.GenerateIcon=t.generate;t.ipc.app.RecordIconHistory=t.record;} return true; });
}
