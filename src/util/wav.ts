/** Encode planar float PCM as a 16-bit or 32-bit-float RIFF/WAVE file. */
export type WavFormat = 'pcm16' | 'float32';

export function encodeWav(channels: Float32Array[], sampleRate: number, format: WavFormat = 'pcm16'): Uint8Array {
  const numCh = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = format === 'pcm16' ? 2 : 4;
  const dataSize = frames * numCh * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, format === 'pcm16' ? 1 : 3, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numCh * bytesPerSample, true);
  v.setUint16(32, numCh * bytesPerSample, true);
  v.setUint16(34, bytesPerSample * 8, true);
  ascii(36, 'data');
  v.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = channels[c]![i]!;
      if (format === 'pcm16') {
        const x = Math.max(-1, Math.min(1, s));
        v.setInt16(off, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true);
      } else {
        v.setFloat32(off, s, true);
      }
      off += bytesPerSample;
    }
  }
  return new Uint8Array(buf);
}

/** Minimal parser for the files encodeWav writes (used by tests and checks). */
export function decodeWav(bytes: Uint8Array): { sampleRate: number; channels: Float32Array[] } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fmt = v.getUint16(20, true);
  const numCh = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  const dataSize = v.getUint32(40, true);
  const bps = bits / 8;
  const frames = dataSize / (numCh * bps);
  const channels = Array.from({ length: numCh }, () => new Float32Array(frames));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      channels[c]![i] = fmt === 1 ? v.getInt16(off, true) / (v.getInt16(off, true) < 0 ? 0x8000 : 0x7fff) : v.getFloat32(off, true);
      off += bps;
    }
  }
  return { sampleRate, channels };
}
