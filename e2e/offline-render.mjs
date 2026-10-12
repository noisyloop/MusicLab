// Optional browser smoke test (not part of `npm test`). See README "Browser smoke tests".
// Usage: node e2e/offline-render.mjs <work-dir-with-fixtures> [app-url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const SP = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ acceptDownloads: true });
await context.addInitScript(() => { delete window.showSaveFilePicker; delete window.showOpenFilePicker; });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(e.message));
await page.goto(process.argv[3] ?? 'http://localhost:5173/');
await page.waitForSelector('[data-testid=timeline]');
await page.mouse.click(600, 400);
await page.getByRole('button', { name: '+ MIDI' }).click();
await page.evaluate(() => {
  const a = window.musiclab;
  const t = a.project.tracks[0];
  a.createMidiClip(t.id, 0, 4);
  const clip = a.project.tracks[0].clips[0];
  // quarter notes C4 E4 G4 C5, one per beat; note in second half of each beat silent
  a.execute({ label: 'notes', apply: (p) => ({ ...p, tracks: p.tracks.map((tr) => tr.id !== t.id ? tr : { ...tr, clips: tr.clips.map((c) => c.id !== clip.id ? c : { ...c, notes: [60, 64, 67, 72].map((pitch, i) => ({ id: 'n' + i, pitch, start: i, length: 0.5, velocity: 1 })) }) }) }) });
});
await page.evaluate(() => window.musiclab.setExportOpen(true));
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
await dl.saveAs(SP + '/midi.wav');
const wav = fs.readFileSync(SP + '/midi.wav');
const sr = wav.readUInt32LE(24);
const frames = (wav.length - 44) / 4;
const rms = (t0, t1) => { let s = 0, n = 0; for (let i = Math.floor(t0 * sr); i < Math.floor(t1 * sr); i++) { const v = wav.readInt16LE(44 + i * 4) / 32768; s += v * v; n++; } return Math.sqrt(s / n); };
// 120bpm: beat = 0.5s; note on 0..0.25s; gap 0.25..0.5 with 250ms release
const on = rms(0.02, 0.22), late = rms(1.9, 2.0), tail = rms(3.6, 3.95);
console.log(`frames ${frames} (${(frames / sr).toFixed(2)}s) note rms ${on.toFixed(4)} last-note ${rms(1.52, 1.72).toFixed(4)} after-notes ${late.toFixed(4)} tail ${tail.toFixed(5)}`);
console.log(on > 0.01 && rms(1.52, 1.72) > 0.01 && tail < 1e-4 ? 'PASS offline synth render timing' : 'FAIL offline synth render');
console.log('logs', logs);
await browser.close();
