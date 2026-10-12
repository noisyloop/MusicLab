// Optional browser smoke test (not part of `npm test`). See README "Browser smoke tests".
// Usage: node e2e/flows.mjs <work-dir-with-fixtures> [app-url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const SP = process.argv[2];
const URL = process.argv[3] ?? 'http://localhost:5173/';
const out = (n) => path.join(SP, n);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
await context.addInitScript(() => {
  // Force the download/input fallback so downloads can be captured.
  delete window.showSaveFilePicker;
  delete window.showOpenFilePicker;
  window.confirm = () => true;
});
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(URL);
await page.waitForSelector('[data-testid=timeline]');
const state = () => page.evaluate(() => JSON.parse(JSON.stringify(window.musiclab.project)));
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) process.exitCode = 1; };

// start audio via a gesture
await page.mouse.click(700, 500);
await page.waitForTimeout(500);
check(await page.evaluate(() => window.musiclab.engine !== null), 'engine started after gesture');

async function dropFiles(names, x, y) {
  const files = names.map((n) => ({ name: n, data: [...fs.readFileSync(path.join(SP, 'audio', n))] }));
  await page.evaluate(({ files, x, y }) => {
    const dt = new DataTransfer();
    for (const f of files) {
      const type = f.name.endsWith('.wav') ? 'audio/wav' : f.name.endsWith('.ogg') ? 'audio/ogg' : f.name.endsWith('.flac') ? 'audio/flac' : f.name.endsWith('.mp3') ? 'audio/mpeg' : '';
      dt.items.add(new File([new Uint8Array(f.data)], f.name, { type }));
    }
    const canvas = document.querySelector('[data-testid=timeline]');
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt };
    canvas.dispatchEvent(new DragEvent('dragenter', opts));
    canvas.dispatchEvent(new DragEvent('dragover', opts));
    canvas.dispatchEvent(new DragEvent('drop', opts));
  }, { files, x, y });
  await page.waitForTimeout(1500);
}

// Timeline canvas is at x=220.., ruler 34px high; toolbar ~40px.
const tl = await page.locator('[data-testid=timeline]').boundingBox();
console.log('timeline box', tl);
await dropFiles(['tone.wav'], tl.x + 200, tl.y + 100);
let p = await state();
check(p.tracks.length === 1 && p.tracks[0].clips.length === 1, 'single wav drop creates track + clip');
check(Math.abs(p.tracks[0].clips[0].length - 4) < 0.01, `2s clip @120bpm = 4 beats (got ${p.tracks[0].clips[0].length})`);
console.log('clip start', p.tracks[0].clips[0].start);

await dropFiles(['beep.ogg', 't.flac', 't.mp3', 'bad.mp3'], tl.x + 100, tl.y + 300);
p = await state();
check(p.tracks.length === 4, `multi drop stacks 3 new tracks (tracks=${p.tracks.length})`);
const toasts = await page.locator('.toast').allTextContents();
check(toasts.some((t) => t.includes('bad.mp3')), `error toast for bad file: ${JSON.stringify(toasts)}`);

// drop onto existing track 0 at a later time
await dropFiles(['t.mp3'], tl.x + 500, tl.y + 34 + 30);
p = await state();
check(p.tracks[0].clips.length === 2, 'drop onto existing audio track adds clip there');

// undo/redo the drop
await page.keyboard.press('Control+z');
p = await state();
check(p.tracks[0].clips.length === 1, 'undo drop');
await page.keyboard.press('Control+Shift+z');
p = await state();
check(p.tracks[0].clips.length === 2, 'redo drop');

// select clip by clicking, move with drag
const c0 = p.tracks[0].clips[0];
const view = await page.evaluate(() => window.musiclab.state.view);
const cx = tl.x + (c0.start - view.scrollBeat) * view.pxPerBeat + 30;
const cy = tl.y + 34 + 32;
await page.mouse.click(cx, cy);
check((await page.evaluate(() => window.musiclab.state.selectedClipIds)).includes(c0.id), 'click selects clip');
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 2 * view.pxPerBeat, cy, { steps: 5 });
await page.mouse.move(cx + 4 * view.pxPerBeat, cy + 64, { steps: 5 });
await page.mouse.up();
p = await state();
const moved = p.tracks.flatMap((t, i) => t.clips.map((c) => ({ ...c, ti: i }))).find((c) => c.id === c0.id);
check(moved.ti === 1 && Math.abs(moved.start - (c0.start + 4)) < 1e-6, `drag moves clip across tracks (ti=${moved.ti}, start=${moved.start})`);

// trim right edge
const x1 = tl.x + (moved.start + moved.length - view.scrollBeat) * view.pxPerBeat - 2;
const y1 = tl.y + 34 + 64 + 32;
await page.mouse.move(x1, y1);
await page.mouse.down();
await page.mouse.move(x1 - 1 * view.pxPerBeat, y1, { steps: 4 });
await page.mouse.up();
p = await state();
const trimmed = p.tracks[1].clips.find((c) => c.id === c0.id);
check(Math.abs(trimmed.length - (moved.length - 1)) < 0.3, `trim right edge (len ${moved.length} -> ${trimmed.length})`);

// split at playhead, duplicate, delete
await page.evaluate((b) => window.musiclab.seek(b), trimmed.start + 1);
await page.mouse.click(tl.x + (trimmed.start + 0.5 - view.scrollBeat) * view.pxPerBeat, y1);
await page.keyboard.press('Control+e');
p = await state();
check(p.tracks[1].clips.length >= 3, `split creates a clip (track1 clips=${p.tracks[1].clips.length})`);
const before = p.tracks[1].clips.length;
await page.keyboard.press('Control+d');
p = await state();
check(p.tracks[1].clips.length === before + 1, 'duplicate');
await page.keyboard.press('Delete');
p = await state();
check(p.tracks[1].clips.length === before, 'delete');

// MIDI: add track, create clip by double-click, draw notes
await page.getByRole('button', { name: '+ MIDI' }).click();
p = await state();
const mi = p.tracks.findIndex((t) => t.kind === 'midi');
check(mi >= 0, 'MIDI track added');
const my = tl.y + 34 + mi * 64 + 32;
await page.mouse.dblclick(tl.x + 10, my);
p = await state();
check(p.tracks[mi].clips.length === 1, 'double-click creates MIDI clip');
check(await page.locator('[data-testid=piano-roll]').isVisible(), 'piano roll opened');
const pr = await page.locator('.pr-canvas canvas').boundingBox();
// draw 3 notes
for (let i = 0; i < 3; i++) {
  await page.mouse.click(pr.x + 60 + i * 60, pr.y + 20 + 40 + i * 12);
}
p = await state();
check(p.tracks[mi].clips[0].notes.length === 3, `drew 3 notes (got ${p.tracks[mi].clips[0].notes.length})`);
// resize a note by drawing drag
await page.mouse.move(pr.x + 60 + 3 * 60, pr.y + 100);
await page.mouse.down();
await page.mouse.move(pr.x + 60 + 3 * 60 + 90, pr.y + 100, { steps: 5 });
await page.mouse.up();
p = await state();
const longest = Math.max(...p.tracks[mi].clips[0].notes.map((n) => n.length));
check(p.tracks[mi].clips[0].notes.length === 4 && longest > 1, `draw-drag creates long note (max len ${longest})`);

// device param
await page.getByTestId('tab-device').click();
await page.getByRole('button', { name: 'Square' }).click();
p = await state();
check(p.tracks[mi].instrument.params.wave === 1, 'device param edit');

// mixer
await page.getByTestId('tab-mixer').click();
check((await page.getByTestId('mixer-strip').count()) === p.tracks.length, 'mixer strips per track');

// play
await page.evaluate(() => window.musiclab.seek(0));
await page.keyboard.press('Space');
await page.waitForTimeout(1500);
const pos = await page.evaluate(() => window.musiclab.position.get().beat);
const meters = await page.evaluate(() => window.musiclab.meters.get().snapshot.master);
check(pos > 1.5, `transport advances (pos ${pos.toFixed(2)} beats after 1.5s)`);
console.log('master meter', meters);
await page.screenshot({ path: out('playing.png') });
await page.keyboard.press('Space');
const stopped = await page.evaluate(() => window.musiclab.state.playing);
check(!stopped, 'space stops');

// loop: enable and play past the loop end
await page.evaluate(() => { const a = window.musiclab; a.execute({ label: 'x', apply: (p) => ({ ...p, loop: { enabled: true, start: 0, end: 2 } }) }); a.seek(0); });
await page.keyboard.press('Space');
await page.waitForTimeout(1600);
const lpos = await page.evaluate(() => window.musiclab.position.get().beat);
check(lpos < 2, `loop wraps (pos ${lpos.toFixed(2)})`);
await page.keyboard.press('Space');

// computer keyboard notes produce sound on the midi track
await page.evaluate((id) => window.musiclab.selectTrack(id), p.tracks[mi].id);
await page.keyboard.down('a');
await page.waitForTimeout(300);
const kmeter = await page.evaluate((id) => window.musiclab.meters.get().snapshot.tracks[id], p.tracks[mi].id);
await page.keyboard.up('a');
check(kmeter[0] > 0.01, `computer keyboard plays synth (meter ${kmeter[0].toFixed(3)})`);

// WAV export
await page.evaluate(() => window.musiclab.execute({ label: 'x', apply: (p) => ({ ...p, loop: { ...p.loop, enabled: false } }) }));
await page.keyboard.press('Control+Shift+e');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByTestId('export-confirm').click()]);
const wavPath = out('export.wav');
await dl.saveAs(wavPath);
const wav = fs.readFileSync(wavPath);
const ch = wav.readUInt16LE(22), sr = wav.readUInt32LE(24), bits = wav.readUInt16LE(34);
let sum = 0, peak = 0; const n = (wav.length - 44) / 2;
for (let i = 0; i < n; i++) { const s = wav.readInt16LE(44 + i * 2) / 32768; sum += s * s; peak = Math.max(peak, Math.abs(s)); }
check(ch === 2 && bits === 16 && n > sr, `wav export header ok (${ch}ch ${sr}Hz ${bits}bit ${(n / 2 / sr).toFixed(2)}s)`);
check(Math.sqrt(sum / n) > 0.01, `wav export has signal (rms ${Math.sqrt(sum / n).toFixed(4)}, peak ${peak.toFixed(3)})`);

// Save -> reload -> open round trip
const projBefore = await state();
const [sdl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
const projPath = out('test.musiclab');
await sdl.saveAs(projPath);
check(!(await page.evaluate(() => window.musiclab.state.dirty)), 'not dirty after save');
await page.reload();
await page.waitForSelector('[data-testid=timeline]');
await page.mouse.click(700, 500);
const bytes = [...fs.readFileSync(projPath)];
await page.evaluate(async (bytes) => {
  await window.musiclab.openProjectFile(new File([new Uint8Array(bytes)], 'test.musiclab'), null, false);
}, bytes);
const projAfter = await state();
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const strip = (pp) => { const { assets, ...rest } = pp; return { rest, assets: Object.keys(assets).sort() }; };
const usedAssets = new Set(projBefore.tracks.flatMap((t) => t.kind === 'audio' ? t.clips.map((c) => c.assetId) : []));
const expected = { ...projBefore, assets: Object.fromEntries(Object.entries(projBefore.assets).filter(([k]) => usedAssets.has(k))) };
check(JSON.stringify(canon(projAfter)) === JSON.stringify(canon(expected)), 'save -> open round trip identical (minus unused assets)');
if (JSON.stringify(canon(projAfter)) !== JSON.stringify(canon(expected))) console.log(JSON.stringify(strip(projAfter)).slice(0, 500), '\n', JSON.stringify(strip(expected)).slice(0, 500));
await page.waitForTimeout(500);
await page.screenshot({ path: out('reopened.png') });

// open piano roll for screenshot
const midiClip = projAfter.tracks.find((t) => t.kind === 'midi').clips[0].id;
await page.evaluate((id) => window.musiclab.openEditor(id), midiClip);
await page.waitForTimeout(300);
await page.screenshot({ path: out('pianoroll.png') });
await page.getByTestId('tab-device').click();
await page.screenshot({ path: out('device.png') });

console.log('--- console errors/warnings ---');
for (const l of logs) console.log(l);
console.log(`(${logs.length} entries)`);
await browser.close();
