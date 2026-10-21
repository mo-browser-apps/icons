// Run against the real Chromium renderer: ICON_PROVIDER=mock npm run dev -- --automation
// Then: node tests/icon-export.mjs [output-directory]
// No image API calls; native export uses an automatically answered save dialog.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const output = process.argv[2] ?? mkdtempSync(path.join(tmpdir(), "moicons-export-"))
mkdirSync(output, { recursive: true })
const agent = (...args) => JSON.parse(execFileSync("npm", [
  "run", "--silent", "mobrowser", "--", "agent", ...args,
], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }))
const evaluate = (expression) => agent("eval", "--expr", expression).value
const pngUrl = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`

// Store helpers in this renderer only. They disappear on reload.
const prepared = evaluate(`(async () => {
  const { prepareIcon } = await import('/lib/prepare-icon.ts');
  const make = (w, h, color) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
    return { canvas, ctx };
  };
  const pixels = async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const { canvas, ctx } = make(bitmap.width, bitmap.height, 'transparent');
    ctx.drawImage(bitmap, 0, 0); bitmap.close();
    return { width: canvas.width, height: canvas.height,
      data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
  };
  const inspect = async (url) => {
    const {width:w,height:h,data} = await pixels(url);
    const at = (x,y) => Array.from(data.slice((y*w+x)*4,(y*w+x)*4+4));
    let partial=0, borderMax=0, minX=w, minY=h, maxX=-1, maxY=-1;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
      const a=data[(y*w+x)*4+3];
      if(a>0 && a<255) partial++;
      if(x===0 || y===0 || x===w-1 || y===h-1) borderMax=Math.max(borderMax,a);
      if(a===255) { minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y); }
    }
    return {width:w,height:h,partial,borderMax,opaqueBounds:[minX,minY,maxX,maxY],
      corners:[at(0,0)[3],at(w-1,0)[3],at(0,h-1)[3],at(w-1,h-1)[3]],
      center:at(Math.floor(w/2),Math.floor(h/2)),
      topShadow:at(Math.floor(w/2),Math.floor(h*0.09))[3],
      bottomShadow:at(Math.floor(w/2),Math.floor(h*0.92))[3]};
  };
  window.__iconExportTest = { pixels, inspect };
  const solid=make(1024,1024,'#4a90d2').canvas.toDataURL();
  const finished=await prepareIcon(solid);
  const rectangle=make(1600,800,'#4a90d2');
  rectangle.ctx.fillStyle='#ff0000';
  rectangle.ctx.beginPath(); rectangle.ctx.arc(800,400,180,0,Math.PI*2); rectangle.ctx.fill();
  const rectPixels=await pixels(await prepareIcon(rectangle.canvas.toDataURL()));
  const redAt=(x,y)=>rectPixels.data[(y*1024+x)*4]>240 && rectPixels.data[(y*1024+x)*4+1]<10;
  let redWidth=0,redHeight=0;
  for(let i=0;i<1024;i++) { if(redAt(i,512)) redWidth++; if(redAt(512,i)) redHeight++; }
  let rejectsInvalid=false;
  try { await prepareIcon('data:image/png;base64,aW52YWxpZA=='); } catch { rejectsInvalid=true; }
  return {solid,finished,stats:await inspect(finished),redWidth,redHeight,rejectsInvalid};
})()`)

assert.equal(prepared.stats.width, 1024)
assert.equal(prepared.stats.height, 1024)
assert.deepEqual(prepared.stats.corners, [0, 0, 0, 0])
assert.equal(prepared.stats.borderMax, 0, "shadow must fade out before the canvas edge")
assert.deepEqual(prepared.stats.opaqueBounds, [100, 100, 923, 923])
assert.deepEqual(prepared.stats.center, [74, 144, 210, 255], "preserve artwork colors")
assert.ok(prepared.stats.partial > 1000, "antialiasing and a soft shadow must survive")
assert.ok(prepared.stats.bottomShadow > prepared.stats.topShadow, "shadow is offset downward")
assert.ok(Math.abs(prepared.redWidth - prepared.redHeight) <= 1, "rectangular input must not stretch the subject")
assert.ok(prepared.rejectsInvalid, "reject invalid image data")
writeFileSync(path.join(output, "before.png"), Buffer.from(prepared.solid.split(",")[1], "base64"))
writeFileSync(path.join(output, "after.png"), Buffer.from(prepared.finished.split(",")[1], "base64"))

// Exercise the actual main-process exporter and iconutil, not a test reimplementation.
const exportPath = path.join(output, "Regression.icns")
agent("answer-dialog", "--path", exportPath)
const saved = evaluate(`(async () => {
  const {ipc}=await import('/gen/ipc.ts');
  const bytes=new Uint8Array(await (await fetch(${JSON.stringify(prepared.finished)})).arrayBuffer());
  return await ipc.app.SaveIcon({imageData:bytes});
})()`)
assert.equal(saved.canceled, false)
assert.equal(saved.icnsPath, exportPath)

const iconset = path.join(output, "Regression.iconset")
const files = readdirSync(iconset).filter((name) => name.endsWith(".png"))
assert.equal(files.length, 10)
const representations = []
for (const file of files) {
  const match = file.match(/^icon_(\d+)x\d+(@2x)?\.png$/)
  assert.ok(match)
  const expectedSize = Number(match[1]) * (match[2] ? 2 : 1)
  const stats = evaluate(`window.__iconExportTest.inspect(${JSON.stringify(pngUrl(path.join(iconset, file)))})`)
  assert.equal(stats.width, expectedSize, file)
  assert.equal(stats.height, expectedSize, file)
  assert.deepEqual(stats.corners, [0, 0, 0, 0], file)
  assert.equal(stats.center[3], 255, file)
  assert.ok(stats.partial > 0, file)
  representations.push({ file, ...stats })
}

const extracted = path.join(output, "Roundtrip.iconset")
execFileSync("iconutil", ["-c", "iconset", exportPath, "-o", extracted])
for (const file of files) {
  const difference = evaluate(`(async () => {
    const {pixels}=window.__iconExportTest;
    const a=await pixels(${JSON.stringify(pngUrl(path.join(iconset, file)))});
    const b=await pixels(${JSON.stringify(pngUrl(path.join(extracted, file)))});
    let alpha=0, color=0;
    for(let i=0;i<a.data.length;i+=4) {
      alpha=Math.max(alpha,Math.abs(a.data[i+3]-b.data[i+3]));
      for(let c=0;c<3;c++) color=Math.max(color,
        Math.abs(a.data[i+c]*a.data[i+3]/255-b.data[i+c]*b.data[i+3]/255));
    }
    return {sameSize:a.width===b.width && a.height===b.height,alpha,color};
  })()`)
  assert.ok(difference.sameSize, file)
  assert.equal(difference.alpha, 0, `${file}: ICNS must preserve alpha exactly`)
  // The two 1x ARGB entries quantize premultiplied channels to 8 bits. Allow
  // one visible level of rounding; PNG-backed entries must remain lossless.
  const tolerance = file === "icon_16x16.png" || file === "icon_32x32.png" ? 1 : 0
  assert.ok(difference.color <= tolerance, `${file}: visible color drift ${difference.color}`)
}
const masterMatches = evaluate(`(async () => {
  const {pixels}=window.__iconExportTest;
  const a=await pixels(${JSON.stringify(prepared.finished)});
  const b=await pixels(${JSON.stringify(pngUrl(path.join(iconset, "icon_512x512@2x.png")))});
  return a.data.every((v,i)=>v===b.data[i]);
})()`)
assert.ok(masterMatches, "the 1024px export must match the prepared preview exactly")
writeFileSync(path.join(output, "checks.json"), JSON.stringify({master:prepared.stats,representations}, null, 2))
console.log(`PASS: mask, margins, shadow, aspect ratio, invalid input, 10 exported sizes, preview equality and ICNS roundtrip.\nArtifacts: ${output}`)
