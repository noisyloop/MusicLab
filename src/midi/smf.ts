/**
 * Standard MIDI File (SMF) reading and writing, written from the spec with no
 * dependencies. This layer only deals in ticks and raw MIDI messages;
 * convert.ts maps between it and the project model (beats).
 *
 * Reading keeps channel voice messages, tempo, time signature and track names.
 * Sysex and all other meta events are skipped. Anything structurally wrong
 * (bad header, truncated chunk, data byte without a status) throws SmfError.
 */

export class SmfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmfError';
  }
}

export type SmfEvent =
  | { type: 'noteOn'; tick: number; channel: number; pitch: number; velocity: number }
  | { type: 'noteOff'; tick: number; channel: number; pitch: number; velocity: number }
  | { type: 'polyPressure'; tick: number; channel: number; pitch: number; pressure: number }
  | { type: 'controlChange'; tick: number; channel: number; controller: number; value: number }
  | { type: 'programChange'; tick: number; channel: number; program: number }
  | { type: 'channelPressure'; tick: number; channel: number; pressure: number }
  /** 14-bit value, 0..16383, 8192 = centre. */
  | { type: 'pitchBend'; tick: number; channel: number; value: number }
  | { type: 'tempo'; tick: number; microsPerQuarter: number }
  | { type: 'timeSignature'; tick: number; numerator: number; denominator: number }
  | { type: 'trackName'; tick: number; name: string }
  | { type: 'endOfTrack'; tick: number };

export interface SmfTrack {
  /** Events in file order; `tick` is absolute from the start of the track. */
  events: SmfEvent[];
}

export interface Smf {
  format: 0 | 1 | 2;
  /** Ticks per quarter note (PPQ). */
  ppq: number;
  tracks: SmfTrack[];
}

// ---------------------------------------------------------------------------
// tick <-> beat

/** Beats are quarter notes, so a beat is exactly `ppq` ticks. */
export function ticksToBeats(ticks: number, ppq: number): number {
  return ticks / ppq;
}

/** Nearest whole tick for a beat position. */
export function beatsToTicks(beats: number, ppq: number): number {
  return Math.max(0, Math.round(beats * ppq));
}

export function bpmFromMicros(microsPerQuarter: number): number {
  return 60_000_000 / microsPerQuarter;
}

export function microsFromBpm(bpm: number): number {
  return Math.round(60_000_000 / bpm);
}

// ---------------------------------------------------------------------------
// reading

class Reader {
  pos = 0;
  constructor(private readonly data: Uint8Array, private readonly end: number, start = 0, private readonly what = 'file') {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) throw new SmfError(`Unexpected end of ${this.what}.`);
  }

  u8(): number {
    this.need(1);
    return this.data[this.pos++]!;
  }

  peek(): number {
    this.need(1);
    return this.data[this.pos]!;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    return ((this.u8() << 24) >>> 0) + ((this.u8() << 16) | (this.u8() << 8) | this.u8());
  }

  ascii(n: number): string {
    this.need(n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.data[this.pos++]!);
    return s;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const b = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  /** Variable-length quantity: at most 4 bytes, 7 bits each. */
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return v >>> 0;
    }
    throw new SmfError('Variable-length value longer than 4 bytes.');
  }

  /** A MIDI data byte (must have the top bit clear). */
  data7(): number {
    const b = this.u8();
    if (b & 0x80) throw new SmfError(`Expected a data byte, got status 0x${b.toString(16)}.`);
    return b;
  }
}

/** Track names may be Latin-1 or UTF-8; decode as UTF-8 when valid. */
function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return String.fromCharCode(...bytes);
  }
}

/** Number of data bytes for a channel message status (high nibble). */
function dataLength(status: number): number {
  const hi = status & 0xf0;
  return hi === 0xc0 || hi === 0xd0 ? 1 : 2;
}

function readTrack(data: Uint8Array, start: number, end: number, index: number): SmfTrack {
  const r = new Reader(data, end, start, `track ${index + 1}`);
  const events: SmfEvent[] = [];
  let tick = 0;
  let running = 0; // running status (0 = none)
  while (!r.done) {
    tick += r.vlq();
    let status = r.peek();
    if (status & 0x80) {
      r.u8();
    } else {
      if (!running) throw new SmfError(`Track ${index + 1}: data byte without a status byte.`);
      status = running;
    }
    if (status === 0xff) {
      running = 0; // meta events cancel running status
      const type = r.u8();
      const len = r.vlq();
      const body = r.bytes(len);
      if (type === 0x2f) {
        events.push({ type: 'endOfTrack', tick });
        break;
      }
      if (type === 0x51) {
        if (len !== 3) throw new SmfError(`Track ${index + 1}: bad tempo event.`);
        const micros = (body[0]! << 16) | (body[1]! << 8) | body[2]!;
        if (micros > 0) events.push({ type: 'tempo', tick, microsPerQuarter: micros });
      } else if (type === 0x58) {
        if (len < 2) throw new SmfError(`Track ${index + 1}: bad time signature event.`);
        events.push({ type: 'timeSignature', tick, numerator: body[0]!, denominator: Math.pow(2, body[1]!) });
      } else if (type === 0x03) {
        events.push({ type: 'trackName', tick, name: decodeText(body) });
      }
      // Other meta events are dropped.
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      running = 0; // sysex cancels running status
      r.bytes(r.vlq()); // dropped
      continue;
    }
    if (status >= 0xf1) throw new SmfError(`Track ${index + 1}: unexpected system message 0x${status.toString(16)}.`);
    running = status;
    const channel = status & 0x0f;
    const a = r.data7();
    const b = dataLength(status) === 2 ? r.data7() : 0;
    switch (status & 0xf0) {
      case 0x80:
        events.push({ type: 'noteOff', tick, channel, pitch: a, velocity: b });
        break;
      case 0x90:
        // Note-on with velocity 0 is a note-off.
        events.push(b === 0 ? { type: 'noteOff', tick, channel, pitch: a, velocity: 64 } : { type: 'noteOn', tick, channel, pitch: a, velocity: b });
        break;
      case 0xa0:
        events.push({ type: 'polyPressure', tick, channel, pitch: a, pressure: b });
        break;
      case 0xb0:
        events.push({ type: 'controlChange', tick, channel, controller: a, value: b });
        break;
      case 0xc0:
        events.push({ type: 'programChange', tick, channel, program: a });
        break;
      case 0xd0:
        events.push({ type: 'channelPressure', tick, channel, pressure: a });
        break;
      case 0xe0:
        events.push({ type: 'pitchBend', tick, channel, value: a | (b << 7) });
        break;
    }
  }
  return { events };
}

export function parseSmf(data: Uint8Array): Smf {
  const r = new Reader(data, data.length);
  if (data.length < 14 || r.ascii(4) !== 'MThd') throw new SmfError('Not a MIDI file (missing MThd header).');
  const headerLen = r.u32();
  if (headerLen < 6) throw new SmfError('MIDI header is too short.');
  const headerEnd = r.pos + headerLen;
  const format = r.u16();
  const declaredTracks = r.u16();
  const division = r.u16();
  if (format > 2) throw new SmfError(`Unknown MIDI file format ${format}.`);
  if (division & 0x8000) throw new SmfError('SMPTE time division is not supported.');
  if (division === 0) throw new SmfError('MIDI file has a time division of 0.');
  if (headerEnd > data.length) throw new SmfError('Unexpected end of file.');
  r.pos = headerEnd;
  const tracks: SmfTrack[] = [];
  while (!r.done && tracks.length < declaredTracks) {
    const id = r.ascii(4);
    const len = r.u32();
    const start = r.pos;
    if (start + len > data.length) throw new SmfError(`Chunk "${id}" is truncated.`);
    if (id === 'MTrk') tracks.push(readTrack(data, start, start + len, tracks.length));
    // Unknown chunk types are skipped, as the spec requires.
    r.pos = start + len;
  }
  if (tracks.length < declaredTracks) throw new SmfError(`File declares ${declaredTracks} tracks but contains ${tracks.length}.`);
  return { format: format as Smf['format'], ppq: division, tracks };
}

// ---------------------------------------------------------------------------
// writing

class Writer {
  private buf: number[] = [];

  u8(v: number): void {
    this.buf.push(v & 0xff);
  }

  u16(v: number): void {
    this.u8(v >> 8);
    this.u8(v);
  }

  u32(v: number): void {
    this.u8(v >>> 24);
    this.u8(v >>> 16);
    this.u8(v >>> 8);
    this.u8(v);
  }

  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }

  bytes(b: ArrayLike<number>): void {
    for (let i = 0; i < b.length; i++) this.u8(b[i]!);
  }

  vlq(v: number): void {
    let n = Math.max(0, Math.min(0x0fffffff, Math.round(v)));
    const stack = [n & 0x7f];
    while ((n >>= 7) > 0) stack.push((n & 0x7f) | 0x80);
    for (let i = stack.length - 1; i >= 0; i--) this.u8(stack[i]!);
  }

  get length(): number {
    return this.buf.length;
  }

  toArray(): number[] {
    return this.buf;
  }
}

const clamp7 = (v: number) => Math.min(127, Math.max(0, Math.round(v)));

function writeEvent(w: Writer, e: SmfEvent): void {
  switch (e.type) {
    case 'noteOn':
      w.bytes([0x90 | e.channel, clamp7(e.pitch), Math.max(1, clamp7(e.velocity))]);
      break;
    case 'noteOff':
      w.bytes([0x80 | e.channel, clamp7(e.pitch), clamp7(e.velocity)]);
      break;
    case 'polyPressure':
      w.bytes([0xa0 | e.channel, clamp7(e.pitch), clamp7(e.pressure)]);
      break;
    case 'controlChange':
      w.bytes([0xb0 | e.channel, clamp7(e.controller), clamp7(e.value)]);
      break;
    case 'programChange':
      w.bytes([0xc0 | e.channel, clamp7(e.program)]);
      break;
    case 'channelPressure':
      w.bytes([0xd0 | e.channel, clamp7(e.pressure)]);
      break;
    case 'pitchBend': {
      const v = Math.min(16383, Math.max(0, Math.round(e.value)));
      w.bytes([0xe0 | e.channel, v & 0x7f, v >> 7]);
      break;
    }
    case 'tempo': {
      const m = Math.min(0xffffff, Math.max(1, Math.round(e.microsPerQuarter)));
      w.bytes([0xff, 0x51, 3, m >> 16, (m >> 8) & 0xff, m & 0xff]);
      break;
    }
    case 'timeSignature':
      w.bytes([0xff, 0x58, 4, e.numerator, Math.round(Math.log2(e.denominator)), 24, 8]);
      break;
    case 'trackName': {
      const text = new TextEncoder().encode(e.name);
      w.bytes([0xff, 0x03]);
      w.vlq(text.length);
      w.bytes(text);
      break;
    }
    case 'endOfTrack':
      w.bytes([0xff, 0x2f, 0]);
      break;
  }
}

/**
 * Serialize an Smf. Events are written in the order given (they must be
 * sorted by tick); an end-of-track event is appended if missing. Running
 * status is not used, which every reader accepts.
 */
export function writeSmf(smf: Smf): Uint8Array {
  const w = new Writer();
  w.ascii('MThd');
  w.u32(6);
  w.u16(smf.format);
  w.u16(smf.tracks.length);
  w.u16(smf.ppq);
  for (const track of smf.tracks) {
    const body = new Writer();
    let last = 0;
    let ended = false;
    for (const e of track.events) {
      if (e.tick < last) throw new Error('writeSmf: events must be sorted by tick');
      body.vlq(e.tick - last);
      last = e.tick;
      writeEvent(body, e);
      if (e.type === 'endOfTrack') {
        ended = true;
        break;
      }
    }
    if (!ended) {
      body.vlq(0);
      writeEvent(body, { type: 'endOfTrack', tick: last });
    }
    w.ascii('MTrk');
    w.u32(body.length);
    w.bytes(body.toArray());
  }
  return Uint8Array.from(w.toArray());
}
