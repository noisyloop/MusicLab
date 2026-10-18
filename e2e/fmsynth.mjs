// Optional browser smoke test (not part of `npm test`). See README "Browser smoke tests".
// Switches a MIDI track to FMSynth from the Device panel, plays it live,
// exports WAV (checked for signal and for silence after the release), saves
// and reopens the project, and undoes the instrument change.
// Usage: node e2e/fmsynth.mjs <work-dir> [app-url]
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

// --- a MIDI track with one bar of notes: C4 E4 G4 C5, a quarter note each, half a beat long
await page.getByRole('button', { name: '+ MIDI' }).click();
await page.evaluate(() => {
  const a = window.musiclab;
  const t = a.project.tracks[0];
  a.createMidiClip(t.id, 0, 4);
  const clip = a.project.tracks[0].clips[0];
  a.execute({ label: 'notes', apply: (p) => ({ ...p, tracks: p.tracks.map((tr) => tr.id !== t.id ? tr : { ...tr, clips: tr.clips.map((c) => c.id !== clip.id ? c : { ...c, notes: [60, 64, 67, 72].map((pitch, i) => ({ id: 'n' + i, pitch, start: i, length: 0.5, velocity: 1 })) }) }) }) });
  a.selectTrack(t.id);
  a.setBottomPanel('device');
});
await page.waitForTimeout(200);

// --- pick FMSynth in the Device panel
await page.getByTestId('instrument-select').selectOption('fmsynth');
await page.waitForTimeout(200);
let p = await state();
check(p.tracks[0].instrument.type === 'fmsynth', 'instrument select switches the track to FMSynth');
check(p.tracks[0].instrument.params.algorithm === 4 && p.tracks[0].instrument.params.op4Ratio === 14, 'FMSynth starts from its default (electric piano) params');
const legends = await page.getByTestId('instrument-card').locator('legend').allTextContents();
check(['Algorithm', 'Op 1', 'Op 2', 'Op 3', 'Op 4', 'Output', 'MIDI'].every((g) => legends.includes(g)), `device panel shows every param group (${legends.join(', ')})`);
check((await page.getByTestId('instrument-card').locator('select').nth(1).inputValue()) === '4', 'algorithm menu shows algorithm 5');
await page.screenshot({ path: out('fmsynth-device.png') });

// --- live playback makes sound
await page.evaluate(() => window.musiclab.seek(0));
await page.keyboard.press('Space');
let livePeak = 0;
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(100);
  const m = await page.evaluate((id) => window.musiclab.meters.get().snapshot.tracks[id], p.tracks[0].id);
  livePeak = Math.max(livePeak, m?.[0] ?? 0);
}
await page.keyboard.press('Space');
check(livePeak > 0.02, `FMSynth plays live (meter peak ${livePeak.toFixed(3)})`);

// --- WAV export: signal while the notes sound, silence once the last release ends
await page.evaluate(() => window.musiclab.setExportOpen(true));
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByTestId('export-confirm').click()]);
await dl.saveAs(out('fmsynth.wav'));
const wav = fs.readFileSync(out('fmsynth.wav'));
const sr = wav.readUInt32LE(24);
const frames = (wav.length - 44) / 4;
const rms = (t0, t1) => { let s = 0, n = 0; for (let i = Math.floor(t0 * sr); i < Math.min(frames, Math.floor(t1 * sr)); i++) { const v = wav.readInt16LE(44 + i * 4) / 32768; s += v * v; n++; } return Math.sqrt(s / Math.max(1, n)); };
// 120 BPM: a beat is 0.5 s. The last note is released at 1.75 s; the longest release is 0.5 s.
const first = rms(0.02, 0.22), last = rms(1.52, 1.72), tail = rms(3.2, 3.9);
check(first > 0.01 && last > 0.01, `WAV has signal for the notes (first ${first.toFixed(4)}, last ${last.toFixed(4)})`);
check(tail < 1e-4, `WAV is silent after the release (${tail.toFixed(5)})`);

// --- save -> reopen keeps the instrument and its params
await page.evaluate(() => window.musiclab.execute({ label: 'tweak', apply: (pr) => ({ ...pr, tracks: pr.tracks.map((t) => ({ ...t, instrument: { ...t.instrument, params: { ...t.instrument.params, feedback: 0.7 } } })) }) }));
const before = await state();
const [sdl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
await sdl.saveAs(out('fmsynth.musiclab'));
await page.evaluate(() => window.musiclab.newProject());
await page.evaluate(async (bytes) => {
  await window.musiclab.openProjectFile(new File([new Uint8Array(bytes)], 'fmsynth.musiclab'), null, false);
}, [...fs.readFileSync(out('fmsynth.musiclab'))]);
const after = await state();
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
check(JSON.stringify(canon(after.tracks[0]?.instrument)) === JSON.stringify(canon(before.tracks[0].instrument)), 'save -> open keeps FMSynth and its params');

// --- undo the instrument change (the reopened project starts a fresh history, so use a new change)
await page.evaluate((id) => { window.musiclab.selectTrack(id); window.musiclab.setBottomPanel('device'); }, after.tracks[0].id);
await page.waitForTimeout(200);
await page.getByTestId('instrument-select').selectOption('subsynth');
p = await state();
check(p.tracks[0].instrument.type === 'subsynth', 'switch back to SubSynth');
await page.keyboard.press('Control+z');
p = await state();
check(p.tracks[0].instrument.type === 'fmsynth' && p.tracks[0].instrument.params.feedback === 0.7, 'undo restores FMSynth with its params');

console.log('--- console errors/warnings ---');
for (const l of logs) console.log(l);
console.log(`(${logs.length} entries)`);
check(logs.length === 0, 'no console errors or warnings');
await browser.close();
