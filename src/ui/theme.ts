/** Colors used by canvas drawing (CSS uses the matching custom properties). */
export const theme = {
  bg: '#1b1d22',
  lane: '#23262c',
  laneAlt: '#202328',
  laneSelected: '#2b2f37',
  ruler: '#2a2d34',
  rulerText: '#a9adb6',
  gridBar: 'rgba(255,255,255,0.16)',
  gridBeat: 'rgba(255,255,255,0.07)',
  gridSub: 'rgba(255,255,255,0.035)',
  playhead: '#ffffff',
  loop: '#f5a623',
  loopDim: 'rgba(245,166,35,0.35)',
  loopOverlay: 'rgba(245,166,35,0.06)',
  selection: '#ffffff',
  marquee: 'rgba(120,170,255,0.18)',
  marqueeBorder: 'rgba(120,170,255,0.8)',
  drop: 'rgba(120,200,255,0.25)',
  text: '#e8e9ec',
  textDim: '#8b9099',
  bend: '#5ad1ff',
};

/** Mix a #rrggbb color toward black (amount < 0) or white (amount > 0). */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => {
    const c = (n >> shift) & 255;
    const t = amount < 0 ? 0 : 255;
    return Math.round(c + (t - c) * Math.abs(amount));
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
