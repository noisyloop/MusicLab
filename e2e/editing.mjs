// Optional browser smoke test (not part of `npm test`). See README "Browser smoke tests".
// Usage: node e2e/editing.mjs <work-dir-with-fixtures> [app-url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const SP = process.argv[2];
const URL = process.argv[3] ?? 'http://localhost:5173/';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(URL);
await page.waitForSelector('[data-testid=timeline]');
const state = () => page.evaluate(() => JSON.parse(JSON.stringify(window.musiclab.project)));
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) process.exitCode = 1; };
const tl = await page.locator('[data-testid=timeline]').boundingBox();
const view = () => page.evaluate(() => window.musiclab.state.view);

await page.getByRole('button', { name: '+ Audio' }).click();
await page.getByRole('button', { name: '+ MIDI' }).click();
await page.getByRole('button', { name: '+ Audio' }).click();
let p = await state();
check(p.tracks.length === 3, 'three tracks added');

// Space while a button has focus toggles playback and does not click the button
await page.getByRole('button', { name: '+ Audio' }).focus();
await page.keyboard.press('Space');
await page.waitForTimeout(300);
check((await state()).tracks.length === 3 && (await page.evaluate(() => window.musiclab.state.playing)), 'space on focused button plays, no click');
await page.keyboard.press('Space');

// ruler click seeks
let v = await view();
await page.mouse.click(tl.x + 8 * v.pxPerBeat + 1, tl.y + 25);
let pos = await page.evaluate(() => window.musiclab.position.get().beat);
check(Math.abs(pos - 8) < 0.01, `ruler click seeks (pos ${pos})`);
check((await page.getByTestId('position').textContent()) === '3.1.1', 'position display shows 3.1.1');

// loop drag in loop strip creates loop region
await page.mouse.move(tl.x + 4 * v.pxPerBeat + 1, tl.y + 6);
await page.mouse.down();
await page.mouse.move(tl.x + 12 * v.pxPerBeat + 1, tl.y + 6, { steps: 6 });
await page.mouse.up();
p = await state();
check(p.loop.enabled && p.loop.start === 4 && p.loop.end === 12, `loop drag creates region ${JSON.stringify(p.loop)}`);
await page.keyboard.press('Control+l');
check(!(await state()).loop.enabled, 'Ctrl+L toggles loop off');

// tempo input
await page.getByTestId('tempo').fill('96');
await page.getByTestId('tempo').press('Enter');
check((await state()).tempo === 96, 'tempo input');
// typing in tempo doesn't trigger shortcuts: "a" shouldn't do anything weird
await page.getByTestId('tempo').fill('100');
await page.getByTestId('tempo').press('Enter');
check((await state()).tempo === 100, 'tempo input 2');

// rename track via double-click
await page.locator('.track-name').first().dblclick();
await page.keyboard.type('Drums');
await page.keyboard.press('Enter');
check((await state()).tracks[0].name === 'Drums', 'rename track (text preselected)');
await page.locator('.track-name').first().dblclick();
await page.keyboard.press('Control+a');
await page.keyboard.type('Drums');
await page.keyboard.press('Enter');
check((await state()).tracks[0].name === 'Drums', 'rename track replace');

// reorder by dragging grip: move track 0 down by 2
const grip = await page.locator('.track-grip').first().boundingBox();
const firstId = (await state()).tracks[0].id;
await page.mouse.move(grip.x + 4, grip.y + 20);
await page.mouse.down();
await page.mouse.move(grip.x + 4, grip.y + 20 + 130, { steps: 8 });
await page.mouse.up();
p = await state();
check(p.tracks[2].id === firstId, 'reorder track via drag');
await page.keyboard.press('Control+z');
check((await state()).tracks[0].id === firstId, 'undo reorder');

// delete track
await page.locator('.track-delete').nth(2).click();
check((await state()).tracks.length === 2, 'delete track');
await page.keyboard.press('Control+z');
check((await state()).tracks.length === 3, 'undo delete track');

// import an audio file onto track 0 and play, then mute -> meter drops
const bytes = [...fs.readFileSync(path.join(SP, 'audio', 'tone.wav'))];
await page.evaluate(async ({ bytes, id }) => {
  await window.musiclab.importAudioFiles([new File([new Uint8Array(bytes)], 'tone.wav', { type: 'audio/wav' })], id, 0);
}, { bytes, id: (await state()).tracks[0].id });
p = await state();
check(p.tracks[0].clips.length === 1, 'import onto audio track');
await page.evaluate(() => window.musiclab.seek(0));
await page.keyboard.press('Space');
await page.waitForTimeout(500);
const tid = p.tracks[0].id;
const lvl1 = await page.evaluate((id) => window.musiclab.meters.get().snapshot.tracks[id][0], tid);
await page.locator('.track-header').first().getByRole('button', { name: 'M' }).click();
await page.waitForTimeout(300);
const lvl2 = await page.evaluate(() => window.musiclab.meters.get().snapshot.master[0]);
check(lvl1 > 0.05 && lvl2 < 0.001, `mute silences track (before ${lvl1.toFixed(3)}, master after ${lvl2.toFixed(4)})`);
await page.locator('.track-header').first().getByRole('button', { name: 'M' }).click();
await page.waitForTimeout(200);
// live edit during playback: delete the playing clip -> silence
await page.evaluate((id) => window.musiclab.selectClips([id]), p.tracks[0].clips[0].id);
await page.keyboard.press('Delete');
await page.waitForTimeout(300);
const lvl3 = await page.evaluate(() => window.musiclab.meters.get().snapshot.master[0]);
check(lvl3 < 0.001, `deleting a playing clip stops it (master ${lvl3.toFixed(4)})`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
const lvl4 = await page.evaluate(() => window.musiclab.meters.get().snapshot.master[0]);
check(lvl4 > 0.05, `undoing the delete during playback re-chases the clip (master ${lvl4.toFixed(3)})`);
// solo another (empty) track -> silence
await page.locator('.track-header').nth(1).getByRole('button', { name: 'S' }).click();
await page.waitForTimeout(300);
const lvl5 = await page.evaluate(() => window.musiclab.meters.get().snapshot.master[0]);
check(lvl5 < 0.001, `solo other track silences this one (${lvl5.toFixed(4)})`);
await page.keyboard.press('Space');

// zoom with ctrl+wheel
v = await view();
await page.mouse.move(tl.x + 300, tl.y + 200);
await page.keyboard.down('Control');
await page.mouse.wheel(0, -200);
await page.keyboard.up('Control');
await page.waitForTimeout(100);
check((await view()).pxPerBeat > v.pxPerBeat, 'ctrl+wheel zooms in');

// beforeunload warning when dirty
let dialogSeen = false;
page.on('dialog', async (d) => { dialogSeen = d.type() === 'beforeunload'; await d.dismiss(); });
await page.mouse.click(tl.x + 600, tl.y + 300);
await page.evaluate(() => { window.location.reload(); }).catch(() => {});
await page.waitForTimeout(800);
check(dialogSeen, 'beforeunload prompt when there are unsaved changes');

console.log('--- console errors/warnings ---');
for (const l of logs) console.log(l);
console.log(`(${logs.length} entries)`);
await page.screenshot({ path: path.join(SP, 'e2e2.png') });
await browser.close();
