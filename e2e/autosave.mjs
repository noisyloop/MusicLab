// Optional browser smoke test (not part of `npm test`). See README "Browser smoke tests".
// Edits a project (audio + MIDI), closes the tab without saving, and checks that
// a new tab offers the autosave, restores it (audio included), and that Discard
// and a clean project remove it. Also checks that an open tab's autosave is not
// offered to another tab.
// Usage: node e2e/autosave.mjs <work-dir-with-fixtures> [app-url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const SP = process.argv[2];
const URL = process.argv[3] ?? 'http://localhost:5173/';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addInitScript(() => {
  window.confirm = () => true;
});
const logs = [];
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) process.exitCode = 1; };

async function open() {
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(URL);
  await page.waitForSelector('[data-testid=timeline]');
  await page.evaluate(() => window.musiclab.initAutosave());
  await page.mouse.click(700, 500); // user gesture: starts the audio engine
  await page.waitForTimeout(300);
  return page;
}
// JSON with sorted keys, so key order (validation rebuilds objects) doesn't matter.
const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const project = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.musiclab.project)));
const sessions = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('musiclab-autosave');
        req.onsuccess = () => {
          const all = req.result.transaction('sessions').objectStore('sessions').getAll();
          all.onsuccess = () => resolve(all.result.map((r) => ({ id: r.sessionId, tracks: r.project.tracks.length })));
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );

// --- tab 1: make unsaved changes
const page1 = await open();
const tl = await page1.locator('[data-testid=timeline]').boundingBox();
const wav = [...fs.readFileSync(path.join(SP, 'audio', 'tone.wav'))];
await page1.evaluate(({ data, x, y }) => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(data)], 'tone.wav', { type: 'audio/wav' }));
  const canvas = document.querySelector('[data-testid=timeline]');
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt };
  for (const type of ['dragenter', 'dragover', 'drop']) canvas.dispatchEvent(new DragEvent(type, opts));
}, { data: wav, x: tl.x + 100, y: tl.y + 100 });
await page1.waitForTimeout(1000);
await page1.evaluate(() => {
  const app = window.musiclab;
  app.addTrack('midi');
  app.createMidiClip(app.state.selectedTrackId, 0);
});
const before = await project(page1);
check(before.tracks.length === 2 && Object.keys(before.assets).length === 1, 'tab 1 has an audio and a MIDI track');
await page1.waitForTimeout(1500); // > autosave delay
let s = await sessions(page1);
check(s.length === 1 && s[0].tracks === 2, `unsaved changes are autosaved (${JSON.stringify(s)})`);
const tab1Session = s[0]?.id;

// --- tab 2 while tab 1 is open: nothing to recover
const page2 = await open();
await page2.waitForTimeout(300);
check((await page2.locator('[data-testid=recovery]').count()) === 0, "an open tab's autosave is not offered to another tab");
await page2.close();

// --- close tab 1 without saving; a new tab offers the work
await page1.close();
const page3 = await open();
await page3.waitForSelector('[data-testid=recovery]', { timeout: 3000 }).catch(() => undefined);
const banner = page3.locator('[data-testid=recovery]');
check((await banner.count()) === 1, 'a closed tab\'s unsaved work is offered after reopening');
check((await banner.textContent())?.includes('Untitled'), `banner names the project: ${await banner.textContent()}`);
await page3.getByTestId('recovery-restore').click();
await page3.waitForFunction(() => window.musiclab.project.tracks.length === 2 && window.musiclab.state.busy === null, null, { timeout: 5000 }).catch(() => undefined);
const after = await project(page3);
check(canonical(after.tracks) === canonical(before.tracks), 'restore brings back the tracks and clips');
const assetId = Object.keys(after.assets)[0];
check(
  await page3.evaluate((id) => (window.musiclab.assets.get(id)?.buffer.duration ?? 0) > 1.9, assetId),
  'restored audio is decoded',
);
check(await page3.evaluate(() => window.musiclab.state.dirty), 'restored project is marked unsaved');
check((await banner.count()) === 0, 'banner closes after restore');
await page3.waitForTimeout(1500);
s = await sessions(page3);
check(s.length === 1 && s[0].id !== tab1Session, `restored work is autosaved under the new tab only (${JSON.stringify(s)})`);

// --- a new (clean) project: the autosave goes away
await page3.evaluate(() => window.musiclab.newProject());
await page3.waitForTimeout(300);
s = await sessions(page3);
check(s.length === 0, 'a clean project leaves no autosave');

// --- Discard
await page3.evaluate(() => window.musiclab.addTrack('midi'));
await page3.waitForTimeout(1500);
await page3.close();
const page4 = await open();
await page4.waitForSelector('[data-testid=recovery]', { timeout: 3000 }).catch(() => undefined);
await page4.getByTestId('recovery-discard').click();
await page4.waitForTimeout(300);
check((await page4.locator('[data-testid=recovery]').count()) === 0, 'discard closes the banner');
check((await sessions(page4)).length === 0, 'discard deletes the autosave');
check((await project(page4)).tracks.length === 0, 'discard leaves the current project alone');

console.log('--- console errors/warnings ---');
for (const l of logs) console.log(l);
console.log(`(${logs.length} entries)`);
await browser.close();
