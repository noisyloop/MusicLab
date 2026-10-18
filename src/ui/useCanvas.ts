import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export interface CanvasSize {
  width: number;
  height: number;
}

/**
 * Keeps a canvas sized to its container (with devicePixelRatio) and runs a
 * redraw loop that calls `draw` whenever `invalidate()` was called or `poll`
 * returns true.
 */
export function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, size: CanvasSize) => void,
  subscribe: (invalidate: () => void) => () => void,
): { canvasRef: RefObject<HTMLCanvasElement | null>; sizeRef: RefObject<CanvasSize>; invalidate: () => void } {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef<CanvasSize>({ width: 0, height: 0 });
  const dirty = useRef(true);
  const drawRef = useRef(draw);
  useLayoutEffect(() => {
    drawRef.current = draw;
  });
  const invalidate = useCallback(() => {
    dirty.current = true;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement!;
    const resize = () => {
      const r = parent.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { width: r.width, height: r.height };
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      dirty.current = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    const unsub = subscribe(invalidate);
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!dirty.current) return;
      dirty.current = false;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRef.current(ctx, sizeRef.current);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsub();
    };
  }, [subscribe, invalidate]);

  return { canvasRef, sizeRef, invalidate };
}
