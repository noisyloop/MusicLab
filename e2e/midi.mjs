// Optional browser smoke test (not part of `npm test`). See README "Browser smoke tests".
// Drops e2e/fixtures/groove.mid onto the arrangement, checks the import, plays
// it, exports MIDI and WAV (checked for signal), and checks a malformed file.
// Usage: node e2e/midi.mjs <work-dir> [app-url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SP = process.argv[2];
const URL = process.argv[3] ?? 'http://localhost:5173/';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'groove.mid');
fs.mkdirSync(SP, { recursive: true });
const out = (n) => path.join(SP, n);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
await context.addInitScript(() => {
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

await page.mouse.click(700, 500); // user gesture: starts the audio engine
await page.waitForTimeout(300);

async function drop(name, bytes, x, y) {
  await page.evaluate(({ name, data, x, y }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], name, { type: 'audio/midi' }));
    const canvas = document.querySelector('[data-testid=timeline]');
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt };
    canvas.dispatchEvent(new DragEvent('dragenter', opts));
    canvas.dispatchEvent(new DragEvent('dragover', opts));
    canvas.dispatchEvent(new DragEvent('drop', opts));
  }, { name, data: [...bytes], x, y });
  await page.waitForTimeout(500);
}

const tl = await page.locator('[data-testid=timeline]').boundingBox();
const view = await page.evaluate(() => window.musiclab.state.view);

// --- malformed file: error toast, nothing changes
await drop('broken.mid', Buffer.from('MThd\0\0\0\x06\0\x01\0\x02\0\x60MTrk\0\0\0\x40\0\x90'), tl.x + 100, tl.y + 100);
let p = await state();
let toasts = await page.locator('.toast').allTextContents();
check(p.tracks.length === 0 && !(await page.evaluate(() => window.musiclab.state.canUndo)), 'malformed .mid changes nothing');
check(toasts.some((t) => t.includes('broken.mid')), `malformed .mid shows an error toast: ${JSON.stringify(toasts)}`);

// --- drop the fixture at bar 2 (beat 4)
const dropX = tl.x + (4 - view.scrollBeat) * view.pxPerBeat + 2;
await drop('groove.mid', fs.readFileSync(FIXTURE), dropX, tl.y + 100);
p = await state();
check(p.tracks.length === 2, `one MIDI track per SMF track with notes (tracks=${p.tracks.length})`);
check(p.tracks.map((t) => t.name).join(',') === 'Drums,Bass', `track names from the file (${p.tracks.map((t) => t.name)})`);
check(p.tracks[0]?.instrument?.type === 'drumkit' && p.tracks[1]?.instrument?.type === 'subsynth', 'channel 10 -> DrumKit, others -> SubSynth');
check(Math.abs(p.tempo - 100) < 1e-6, `empty project adopts the file's first tempo (${p.tempo})`);
const [dclip, bclip] = p.tracks.map((t) => t.clips[0]);
check(dclip.start === 4 && bclip.start === 4 && dclip.length === 8, `clips start at the drop beat (start ${dclip.start}, len ${dclip.length})`);
check(dclip.notes.length === 27 && bclip.notes.length === 6, `notes imported (drums ${dclip.notes.length}, bass ${bclip.notes.length})`);
check(bclip.bends?.length === 10 && bclip.ccs?.length === 17, `bends and CCs kept (bends ${bclip.bends?.length}, ccs ${bclip.ccs?.length})`);
check(Math.abs(Math.max(...bclip.bends.map((b) => b.semitones)) - 12 * 8191 / 8192) < 1e-9, 'bend range from RPN 0 (12 semitones)');

// --- one undo step
await page.keyboard.press('Control+z');
p = await state();
check(p.tracks.length === 0 && p.tempo === 120, 'one undo removes the whole import (and the tempo change)');
await page.keyboard.press('Control+Shift+z');
p = await state();
check(p.tracks.length === 2, 'redo restores it');

// --- piano roll shows the bend curve; device panel shows the kit
await page.evaluate((id) => window.musiclab.openEditor(id), bclip.id);
await page.waitForTimeout(300);
await page.screenshot({ path: out('midi-pianoroll.png') });
await page.evaluate((id) => { window.musiclab.selectTrack(id); window.musiclab.setBottomPanel('device'); }, p.tracks[0].id);
await page.waitForTimeout(200);
check((await page.getByTestId('instrument-select').inputValue()) === 'drumkit', 'device panel shows DrumKit');
await page.screenshot({ path: out('midi-drumkit.png') });

// --- live playback: the drum track makes sound
await page.evaluate(() => window.musiclab.seek(4));
await page.keyboard.press('Space');
let drumPeak = 0;
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(100);
  const m = await page.evaluate((id) => window.musiclab.meters.get().snapshot.tracks[id], p.tracks[0].id);
  drumPeak = Math.max(drumPeak, m?.[0] ?? 0);
}
await page.keyboard.press('Space');
check(drumPeak > 0.05, `DrumKit plays live (meter peak ${drumPeak.toFixed(3)})`);

// --- export MIDI
await page.evaluate(() => window.musiclab.setMidiExportOpen(true));
const [mdl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByTestId('export-midi-confirm').click()]);
await mdl.saveAs(out('export.mid'));
const mid = fs.readFileSync(out('export.mid'));
check(mid.subarray(0, 4).toString() === 'MThd' && mid.readUInt16BE(8) === 1 && mid.readUInt16BE(10) === 3, `MIDI export: format 1, tempo + 2 tracks (${mid.length} bytes)`);

// re-import the export into a fresh project: same notes, bends and CCs
const reimported = await page.evaluate(async (data) => {
  const a = window.musiclab;
  const before = JSON.parse(JSON.stringify(a.project));
  a.newProject();
  await a.importMidiFile(new File([new Uint8Array(data)], 'export.mid'), 4);
  const after = JSON.parse(JSON.stringify(a.project));
  return { before, after };
}, [...mid]);
const shape = (proj) => proj.tracks.map((t) => ({ name: t.name, inst: t.instrument.type, notes: t.clips[0].notes.map(({ id, ...n }) => n).sort((x, y) => x.start - y.start || x.pitch - y.pitch), bends: t.clips[0].bends ?? [], ccs: t.clips[0].ccs ?? [] }));
// The export starts at beat 0, so re-imported content sits 4 beats later in its clip.
const shifted = shape(reimported.after).map((t) => ({ ...t, notes: t.notes.map((n) => ({ ...n, start: n.start - 4 })), bends: t.bends.map((b) => ({ ...b, beat: b.beat - 4 })), ccs: t.ccs.map((c) => ({ ...c, beat: c.beat - 4 })) }));
const approx = (a, b) => JSON.stringify(a, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)) === JSON.stringify(b, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
check(approx(shifted, shape(reimported.before)), 'MIDI export -> import round trip in the browser');
if (!approx(shifted, shape(reimported.before))) {
  // Print the first difference.
  const a = shifted, b = shape(reimported.before);
  const walk = (x, y, at) => {
    if (typeof x !== 'object' || x === null) return approx(x, y) ? null : `${at}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y ?? {})])) {
      const d = walk(x[k], y?.[k], `${at}.${k}`);
      if (d) return d;
    }
    return null;
  };
  console.log('first difference (reimported vs original):', walk(a, b, 'tracks'));
}

// --- WAV export of the imported groove has signal
await page.evaluate(() => window.musiclab.setExportOpen(true));
const [wdl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByTestId('export-confirm').click()]);
await wdl.saveAs(out('midi-export.wav'));
const wav = fs.readFileSync(out('midi-export.wav'));
const ch = wav.readUInt16LE(22), sr = wav.readUInt32LE(24);
const frames = (wav.length - 44) / 4;
const rms = (t0, t1) => { let s = 0, n = 0; for (let i = Math.floor(t0 * sr); i < Math.min(frames, Math.floor(t1 * sr)); i++) { const v = wav.readInt16LE(44 + i * 4) / 32768; s += v * v; n++; } return Math.sqrt(s / Math.max(1, n)); };
// 100 BPM: 0.6 s per beat; content starts at beat 4 = 2.4 s, the song ends at beat 12 = 7.2 s.
const lead = rms(0, 2.3), groove = rms(2.4, 7.2);
check(ch === 2 && frames / sr > 7, `WAV header ok (${ch}ch ${sr}Hz ${(frames / sr).toFixed(2)}s)`);
check(lead < 1e-4 && groove > 0.02, `WAV has signal where the clips are (before ${lead.toFixed(5)}, groove ${groove.toFixed(4)})`);

console.log('--- console errors/warnings ---');
for (const l of logs) console.log(l);
console.log(`(${logs.length} entries)`);
await browser.close();
