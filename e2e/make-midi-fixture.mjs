// Writes e2e/fixtures/groove.mid, the Standard MIDI File used by e2e/midi.mjs.
// Bytes are assembled by hand (not with the app's writer) so the import is
// tested against the spec. Format 1, PPQ 96, 100 BPM, 4/4, two bars:
//   track 1: tempo/time signature (conductor)
//   track 2: "Drums" on channel 10 (kick, snare, closed/open hat, clap)
//   track 3: "Bass" on channel 1, with RPN bend range 12, pitch bends and CC 74
// Usage: node e2e/make-midi-fixture.mjs [out-path]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PPQ = 96;
const vlq = (v) => {
  const out = [v & 0x7f];
  while ((v >>= 7) > 0) out.unshift((v & 0x7f) | 0x80);
  return out;
};
const text = (type, s) => [0xff, type, ...vlq(Buffer.byteLength(s)), ...Buffer.from(s)];

/** events: [tick, ...bytes]; sorted by tick, written with delta times. */
function track(events) {
  events.sort((a, b) => a[0] - b[0]);
  const body = [];
  let last = 0;
  for (const [tick, ...bytes] of events) {
    body.push(...vlq(tick - last), ...bytes);
    last = tick;
  }
  body.push(0, 0xff, 0x2f, 0);
  return [...Buffer.from('MTrk'), (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
}

const conductor = [
  [0, ...text(0x03, 'Groove')],
  [0, 0xff, 0x58, 4, 4, 2, 24, 8],
  [0, 0xff, 0x51, 3, 0x09, 0x27, 0xc0], // 600000 us = 100 BPM
  [PPQ * 4, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], // later tempo change (ignored on import)
];

const drums = [[0, ...text(0x03, 'Drums')]];
const hit = (beat, pitch, vel, len = PPQ / 8) => {
  drums.push([Math.round(beat * PPQ), 0x99, pitch, vel], [Math.round(beat * PPQ) + len, 0x99, pitch, 0]); // vel 0 = note off
};
for (let bar = 0; bar < 2; bar++) {
  const b = bar * 4;
  hit(b, 36, 120);
  hit(b + 2, 36, 110);
  hit(b + 2.5, 36, 90);
  hit(b + 1, 38, 110);
  hit(b + 3, 38, 115);
  for (let e = 0; e < 8; e++) hit(b + e / 2, e === 7 ? 46 : 42, e % 2 ? 70 : 95);
  if (bar === 1) hit(b + 3.75, 39, 100);
}

const bass = [
  [0, ...text(0x03, 'Bass')],
  [0, 0xc0, 38], // program change (dropped on import)
  [0, 0xb0, 101, 0], [0, 0xb0, 100, 0], [0, 0xb0, 6, 12], [0, 0xb0, 101, 127], [0, 0xb0, 100, 127],
  [0, 0xb0, 74, 40],
];
const notes = [[0, 36, 1.5], [2, 36, 0.5], [2.5, 39, 1], [4, 31, 1.5], [6, 34, 0.75], [7, 36, 1]];
for (const [beat, pitch, len] of notes) bass.push([beat * PPQ, 0x90, pitch, 100], [(beat + len) * PPQ, 0x80, pitch, 0]);
// A bend up an octave and back on the last note, and a filter sweep in bar 2.
for (let i = 0; i <= 8; i++) {
  const v = 8192 + Math.round((i / 8) * 8191);
  bass.push([7 * PPQ + i * 4, 0xe0, v & 0x7f, v >> 7]);
}
bass.push([8 * PPQ - 1, 0xe0, 0x00, 0x40]);
for (let i = 0; i < 16; i++) bass.push([4 * PPQ + i * 24, 0xb0, 74, 40 + i * 5]);

const header = [...Buffer.from('MThd'), 0, 0, 0, 6, 0, 1, 0, 3, 0, PPQ];
const bytes = Buffer.from([...header, ...track(conductor), ...track(drums), ...track(bass)]);
const out = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'groove.mid');
fs.writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.length} bytes)`);
