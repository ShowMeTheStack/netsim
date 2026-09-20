// A tiny drag hook for the node/link popups: grab the header to move the modal
// anywhere, clamped so the header stays on-screen. Ignores clicks on form controls
// so buttons and inputs in the header still work.
import React, { useRef, useState } from 'react';

export function useDragOffset() {
  const [off, setOff] = useState({ x: 0, y: 0 });
  const ref = useRef(off); ref.current = off;
  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,input,select,textarea,a')) return;
    e.preventDefault();
    const modal = (e.currentTarget as HTMLElement).closest('.modal') as HTMLElement | null;
    const rect = modal?.getBoundingClientRect();
    const o = ref.current;
    // Base (untransformed) position, so we can clamp the moved modal to the viewport.
    const baseL = rect ? rect.left - o.x : 0, baseT = rect ? rect.top - o.y : 0;
    const w = rect?.width ?? 0, h = rect?.height ?? 0;
    const sx = e.clientX, sy = e.clientY;
    const move = (ev: MouseEvent) => {
      let x = o.x + (ev.clientX - sx), y = o.y + (ev.clientY - sy);
      if (rect) {
        const minX = 40 - (baseL + w), maxX = window.innerWidth - 40 - baseL;
        const minY = -baseT, maxY = window.innerHeight - 40 - baseT;
        x = Math.max(minX, Math.min(x, maxX)); y = Math.max(minY, Math.min(y, maxY));
      }
      setOff({ x, y });
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); document.body.style.userSelect = 'none';
  };
  return { style: { transform: `translate(${off.x}px, ${off.y}px)` } as React.CSSProperties, onMouseDown };
}
