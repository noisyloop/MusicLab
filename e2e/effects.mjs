// Optional browser smoke test (not part of `npm test`). See README "Browser smoke tests".
// Adds a Delay to a MIDI track through the Device panel, exports WAV, and checks
// that signal continues after the last note ends (and is gone when bypassed).
// Also covers the FX badge, drag-reordering, the compressor's gain-reduction
// meter during playback, and the master chain.
// Usage: node e2e/effects.mjs <work-dir> [app-url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const SP = process.argv[2];
const URL = process.argv[3] ?? 'http://localhost:5173/';
fs.mkdirSync(SP, { recursive: true });
const out = (n) => path.join(SP, n);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
await context.addInitScript(() => {
  delete window.showSaveFilePicker;
  delete window.showOpenFilePicker;
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
await page.getByRole('button', { name: '+ MIDI' }).click();
// One short note at beat 0 (120 BPM: 0.125 s long; SubSynth's 0.25 s release is silent by ~0.5 s).
await page.evaluate(() => {
  const a = window.musiclab;
  const t = a.project.tracks[0];
  a.createMidiClip(t.id, 0, 4);
  const clip = a.project.tracks[0].clips[0];
  a.execute({ label: 'note', apply: (p) => ({ ...p, tracks: p.tracks.map((tr) => tr.id !== t.id ? tr : { ...tr, clips: tr.clips.map((c) => c.id !== clip.id ? c : { ...c, notes: [{ id: 'n1', pitch: 60, start: 0, length: 0.25, velocity: 1 }] }) }) }) });
  a.selectTrack(t.id);
  a.setBottomPanel('device');
});
let p = await state();
const trackId = p.tracks[0].id;

// --- add a Delay through the "+" menu
await page.getByTestId('add-effect').click();
await page.getByRole('menuitem', { name: 'Delay' }).click();
p = await state();
check(p.tracks[0].effects.length === 1 && p.tracks[0].effects[0].type === 'delay', 'Delay added to the MIDI track from the + menu');
check((await page.getByTestId('effect-card').count()) === 1 && (await page.getByTestId('instrument-card').count()) === 1, 'Device panel shows instrument card then the effect card');
// More feedback and wet so the echoes are easy to measure.
await page.evaluate((id) => {
  const a = window.musiclab;
  const fx = a.project.tracks[0].effects[0].id;
  a.execute({ label: 'fx', apply: (p) => ({ ...p, tracks: p.tracks.map((t) => t.id !== id ? t : { ...t, effects: t.effects.map((e) => e.id !== fx ? e : { ...e, params: { ...e.params, feedback: 0.6, mix: 0.5 } }) }) }) });
}, trackId);

async function exportWav(name) {
  await page.evaluate(() => window.musiclab.setExportOpen(true));
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByTestId('export-confirm').click()]);
  await dl.saveAs(out(name));
  const wav = fs.readFileSync(out(name));
  const sr = wav.readUInt32LE(24);
  const frames = (wav.length - 44) / 4;
  const rms = (t0, t1) => { let s = 0, n = 0; for (let i = Math.floor(t0 * sr); i < Math.min(frames, Math.floor(t1 * sr)); i++) { const v = wav.readInt16LE(44 + i * 4) / 32768; s += v * v; n++; } return Math.sqrt(s / Math.max(1, n)); };
  return { seconds: frames / sr, rms };
}

const wet = await exportWav('delay.wav');
// Echoes at 0.375 s, 0.75 s, 1.125 s ... (1/8 dotted at 120 BPM); the note itself is gone by ~0.5 s.
const echo = wet.rms(0.7, 1.6);
check(wet.seconds > 2 + 4, `export tail grew for the delay (${wet.seconds.toFixed(2)} s; 2 s of song + base 2 s + delay tail)`);
check(echo > 1e-3, `signal continues after the last note ends (rms 0.7–1.6 s = ${echo.toFixed(4)})`);
check(wet.rms(4, 5) > 1e-5, `echoes still audible 4 s in (rms ${wet.rms(4, 5).toFixed(6)})`);

// --- bypass from the card: the echoes go away
await page.getByTestId('effect-bypass').click();
p = await state();
check(p.tracks[0].effects[0].bypass === true, 'bypass toggle sets bypass');
const dry = await exportWav('dry.wav');
check(dry.rms(0.7, 1.6) < echo / 100, `bypassed delay: silence after the note (rms ${dry.rms(0.7, 1.6).toFixed(6)} vs ${echo.toFixed(4)} with the delay)`);
check(dry.rms(0, 0.12) > 0.01, `the note itself still plays when bypassed (rms ${dry.rms(0, 0.12).toFixed(4)})`);
await page.getByTestId('effect-bypass').click();

// --- FX badge in the mixer opens the chain
await page.evaluate(() => window.musiclab.selectTrack(null));
await page.getByTestId('tab-mixer').click();
check((await page.getByTestId('fx-badge').first().textContent()) === 'FX 1', 'mixer strip shows an FX 1 badge');
await page.getByTestId('fx-badge').first().click();
check((await page.evaluate(() => [window.musiclab.state.bottomPanel, window.musiclab.state.selectedTrackId])).join() === `device,${trackId}`, 'clicking the badge opens the chain in the Device panel');

// --- add a compressor, drag it before the delay, watch gain reduction while playing
await page.getByTestId('add-effect').click();
await page.getByRole('menuitem', { name: 'Compressor' }).click();
await page.evaluate((id) => {
  const a = window.musiclab;
  a.execute({ label: 'fx', apply: (p) => ({ ...p, tracks: p.tracks.map((t) => t.id !== id ? t : { ...t, effects: t.effects.map((e) => e.type !== 'compressor' ? e : { ...e, params: { ...e.params, threshold: -45, ratio: 10 } }) }) }) });
}, trackId);
// HTML5 drag needs real intermediate mouse moves (locator.dragTo jumps and never starts a drag here).
const cards = page.getByTestId('effect-card');
const from = await cards.nth(1).locator('.card-title').boundingBox();
const to = await cards.nth(0).boundingBox();
await page.mouse.move(from.x + 5, from.y + 5);
await page.mouse.down();
await page.mouse.move(from.x + 20, from.y + 10, { steps: 5 });
await page.mouse.move(to.x + 30, to.y + 60, { steps: 10 });
await page.mouse.up();
p = await state();
check(p.tracks[0].effects.map((e) => e.type).join() === 'compressor,delay', `drag reorders the chain (${p.tracks[0].effects.map((e) => e.type)})`);
await page.evaluate(() => window.musiclab.seek(0));
await page.keyboard.press('Space');
let gr = 0;
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(60);
  gr = Math.max(gr, parseFloat((await page.getByTestId('gain-reduction').textContent()).replace(/[^0-9.]/g, '')) || 0);
}
// Rewire during playback (remove + undo) must not throw.
await page.evaluate((id) => { const a = window.musiclab; const fx = a.project.tracks[0].effects[1].id; a.execute({ label: 'rm', apply: (p) => ({ ...p, tracks: p.tracks.map((t) => t.id !== id ? t : { ...t, effects: t.effects.filter((e) => e.id !== fx) }) }) }); a.undo(); }, trackId);
await page.waitForTimeout(200);
await page.keyboard.press('Space');
check(gr > 3, `compressor card shows live gain reduction (max ${gr.toFixed(1)} dB)`);
await page.screenshot({ path: out('effects-chain.png') });

// --- master chain via the master strip
await page.getByTestId('tab-mixer').click();
await page.getByTestId('master-strip').click();
await page.getByTestId('tab-device').click();
await page.getByTestId('add-effect').click();
await page.getByRole('menuitem', { name: 'Reverb' }).click();
p = await state();
check(p.master.effects.length === 1 && p.master.effects[0].type === 'reverb' && p.tracks[0].effects.length === 2, 'master strip opens the master chain; Reverb added there');
await page.screenshot({ path: out('effects-master.png') });

// --- one undo per edit
await page.keyboard.press('Control+z');
p = await state();
check(p.master.effects.length === 0, 'undo removes the master effect');

console.log('--- console errors/warnings ---');
for (const l of logs) console.log(l);
console.log(`(${logs.length} entries)`);
await browser.close();
