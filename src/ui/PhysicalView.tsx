// Physical-layer signal view: render the first bytes of a frame as a line-code waveform.
// Shows NRZ, NRZI, Manchester and 4B5B (over NRZI) so students connect "bits" to "signal on a wire".
import React, { useEffect, useRef, useState } from 'react';
type Encoding = 'nrz' | 'nrzi' | 'manchester' | '4b5b';
const NIBBLE_4B5B: Record<number, number> = { 0x0: 0b11110, 0x1: 0b01001, 0x2: 0b10100, 0x3: 0b10101, 0x4: 0b01010, 0x5: 0b01011, 0x6: 0b01110, 0x7: 0b01111, 0x8: 0b10010, 0x9: 0b10011, 0xa: 0b10110, 0xb: 0b10111, 0xc: 0b11010, 0xd: 0b11011, 0xe: 0b11100, 0xf: 0b11101 };
function bitsOf(bytes: Uint8Array): number[] { const out: number[] = []; for (const b of bytes) for (let i = 7; i >= 0; i--) out.push((b >> i) & 1); return out; }
function bits4b5b(bytes: Uint8Array): number[] { const out: number[] = []; for (const b of bytes) { for (const nib of [(b >> 4) & 0xf, b & 0xf]) { const code = NIBBLE_4B5B[nib]!; for (let i = 4; i >= 0; i--) out.push((code >> i) & 1); } } return out; }

export function PhysicalView({ bytes }: { bytes: Uint8Array }) {
  const [enc, setEnc] = useState<Encoding>('manchester'); const [nbytes, setNbytes] = useState(4); const ref = useRef<HTMLCanvasElement>(null);
  const slice = bytes.subarray(0, Math.min(nbytes, bytes.length));
  useEffect(() => {
    const cv = ref.current!; const dpr = window.devicePixelRatio || 1; const W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); const css = getComputedStyle(document.documentElement); const v = (k: string) => css.getPropertyValue(k).trim();
    g.fillStyle = v('--bg'); g.fillRect(0, 0, W, H);
    const dataBits = enc === '4b5b' ? bits4b5b(slice) : bitsOf(slice); const n = dataBits.length; if (!n) return;
    const padL = 8, padR = 8, padT = 24, padB = 18; const pw = W - padL - padR; const bw = pw / n; const hi = padT, lo = H - padB, mid = (hi + lo) / 2;
    // bit grid + labels
    g.strokeStyle = v('--grid'); g.fillStyle = v('--fg2'); g.font = '10px var(--mono)'; g.textAlign = 'center';
    for (let i = 0; i <= n; i++) { const x = padL + i * bw; g.beginPath(); g.moveTo(x, padT - 4); g.lineTo(x, lo + 4); g.stroke(); if (i < n) g.fillText(String(dataBits[i]), x + bw / 2, 14); }
    // waveform
    g.strokeStyle = v('--accent'); g.lineWidth = 2; g.beginPath();
    let level = lo; let lastNrzi = 0; // NRZI starts low
    const moveTo = (x: number, y: number) => g.moveTo(x, y); const lineTo = (x: number, y: number) => g.lineTo(x, y);
    let x = padL; moveTo(x, level);
    for (let i = 0; i < n; i++) {
      const bit = dataBits[i]!; const x0 = padL + i * bw, x1 = x0 + bw;
      if (enc === 'nrz') { const y = bit ? hi : lo; lineTo(x0, y); lineTo(x1, y); level = y; }
      else if (enc === 'nrzi' || enc === '4b5b') { if (bit === 1) lastNrzi ^= 1; const y = lastNrzi ? hi : lo; lineTo(x0, level); lineTo(x0, y); lineTo(x1, y); level = y; }
      else { // Manchester (802.3): 0 = high→low, 1 = low→high, with a guaranteed mid-bit transition
        const first = bit ? lo : hi, second = bit ? hi : lo; const xm = (x0 + x1) / 2;
        lineTo(x0, level); lineTo(x0, first); lineTo(xm, first); lineTo(xm, second); lineTo(x1, second); level = second;
      }
    }
    g.stroke();
    g.strokeStyle = v('--border'); g.setLineDash([2, 3]); g.beginPath(); g.moveTo(padL, mid); g.lineTo(W - padR, mid); g.stroke(); g.setLineDash([]);
  });
  return (
    <div data-testid="physical-view" style={{ marginTop: 8 }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="muted">Line coding:</span>
        {(['nrz', 'nrzi', 'manchester', '4b5b'] as Encoding[]).map(e => <button key={e} data-testid={`enc-${e}`} className={enc === e ? 'active' : ''} onClick={() => setEnc(e)}>{e === '4b5b' ? '4B/5B' : e.toUpperCase()}</button>)}
        <span className="muted">bytes</span><input type="number" min={1} max={12} value={nbytes} onChange={e => setNbytes(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} style={{ width: 56 }} />
      </div>
      <canvas ref={ref} data-testid="phys-canvas" style={{ width: '100%', height: 90, display: 'block', border: '1px solid var(--border)', borderRadius: 6 }} />
      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{enc === 'nrz' ? 'NRZ: high = 1, low = 0.' : enc === 'nrzi' ? 'NRZI: a transition at the start of a bit means 1; no transition means 0.' : enc === 'manchester' ? 'Manchester: every bit has a mid-transition; low→high = 1, high→low = 0. Self-clocking.' : '4B/5B: each 4-bit nibble maps to a 5-bit symbol (guarantees transitions), shown here over NRZI.'}</div>
    </div>
  );
}
