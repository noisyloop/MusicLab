import { useEffect, useRef } from 'react';
import { app } from '../app/controller';
import type { Id } from '../model/types';

/** dB scale for meters: -60..+6 dB mapped to 0..1. */
function levelToPos(level: number): number {
  if (level <= 0.001) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, (db + 60) / 66));
}

/**
 * Stereo peak meter. Draws imperatively from the meter store so it never
 * re-renders React; decays smoothly and holds peaks briefly.
 */
export function Meter({ source, orientation = 'vertical' }: { source: Id | 'master'; orientation?: 'vertical' | 'horizontal' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const disp = [0, 0];
    const hold = [0, 0];
    const holdAge = [0, 0];
    const draw = () => {
      const snap = app.meters.get().snapshot;
      const lv = source === 'master' ? snap.master : (snap.tracks[source] ?? [0, 0]);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#121417';
      ctx.fillRect(0, 0, w, h);
      for (let c = 0; c < 2; c++) {
        const p = levelToPos(lv[c] ?? 0);
        disp[c] = p > disp[c]! ? p : Math.max(p, disp[c]! - 0.015);
        if (p >= hold[c]!) {
          hold[c] = p;
          holdAge[c] = 0;
        } else if (++holdAge[c]! > 60) hold[c] = Math.max(0, hold[c]! - 0.01);
        const clipped = (lv[c] ?? 0) >= 1;
        const color = clipped ? '#ff4d4d' : disp[c]! > 60 / 66 ? '#f5d423' : '#4cd964';
        ctx.fillStyle = color;
        if (orientation === 'vertical') {
          const bw = (w - 1) / 2;
          const bh = disp[c]! * h;
          ctx.fillRect(c * (bw + 1), h - bh, bw, bh);
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          if (hold[c]! > 0) ctx.fillRect(c * (bw + 1), h - hold[c]! * h, bw, 1);
        } else {
          const bh = (h - 1) / 2;
          ctx.fillRect(0, c * (bh + 1), disp[c]! * w, bh);
        }
      }
    };
    return app.meters.subscribe(draw);
  }, [source, orientation]);
  return <canvas ref={ref} className={`meter meter-${orientation}`} />;
}
