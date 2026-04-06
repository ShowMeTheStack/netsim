// Byte-level helpers shared by engine and UI. Everything here is pure.

export class ByteWriter {
  private buf: Uint8Array;
  private pos = 0;
  constructor(initial = 256) { this.buf = new Uint8Array(initial); }
  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap); nb.set(this.buf); this.buf = nb;
  }
  get length() { return this.pos; }
  u8(v: number) { this.ensure(1); this.buf[this.pos++] = v & 0xff; return this; }
  u16(v: number) { this.ensure(2); this.buf[this.pos++] = (v >>> 8) & 0xff; this.buf[this.pos++] = v & 0xff; return this; }
  u32(v: number) { this.ensure(4); this.buf[this.pos++] = (v >>> 24) & 0xff; this.buf[this.pos++] = (v >>> 16) & 0xff; this.buf[this.pos++] = (v >>> 8) & 0xff; this.buf[this.pos++] = v & 0xff; return this; }
  bytes(b: ArrayLike<number>) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this; }
  ascii(s: string) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return this.bytes(b); }
  utf8(s: string) { return this.bytes(new TextEncoder().encode(s)); }
  patchU16(at: number, v: number) { this.buf[at] = (v >>> 8) & 0xff; this.buf[at + 1] = v & 0xff; }
  toBytes(): Uint8Array { return this.buf.slice(0, this.pos); }
}

export class ByteReader {
  pos = 0;
  constructor(public readonly buf: Uint8Array, start = 0, public readonly end = buf.length) { this.pos = start; }
  get remaining() { return this.end - this.pos; }
  need(n: number) { if (this.pos + n > this.end) throw new RangeError(`short read: need ${n} at ${this.pos}, end ${this.end}`); }
  u8() { this.need(1); return this.buf[this.pos++]!; }
  u16() { this.need(2); const v = (this.buf[this.pos]! << 8) | this.buf[this.pos + 1]!; this.pos += 2; return v; }
  u32() { this.need(4); const v = ((this.buf[this.pos]! << 24) | (this.buf[this.pos + 1]! << 16) | (this.buf[this.pos + 2]! << 8) | this.buf[this.pos + 3]!) >>> 0; this.pos += 4; return v; }
  bytes(n: number) { this.need(n); const b = this.buf.slice(this.pos, this.pos + n); this.pos += n; return b; }
  rest() { return this.bytes(this.remaining); }
  peekU8(off = 0) { return this.buf[this.pos + off] ?? 0; }
}

export function hex(b: ArrayLike<number>, sep = ''): string {
  let s = ''; for (let i = 0; i < b.length; i++) { if (i && sep) s += sep; s += (b[i]! & 0xff).toString(16).padStart(2, '0'); } return s;
}
export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-fA-F]/g, ''); const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16); return out;
}
export function toBase64(b: Uint8Array): string {
  let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!); return btoa(s);
}
export function fromBase64(s: string): Uint8Array {
  const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}
export function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true;
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

// ---- MAC ----
export type Mac = string; // "aa:bb:cc:dd:ee:ff" lowercase
export const BROADCAST_MAC: Mac = 'ff:ff:ff:ff:ff:ff';
export function macToBytes(m: Mac): Uint8Array { return fromHex(m); }
export function bytesToMac(b: ArrayLike<number>): Mac { return hex(b, ':'); }
export function isBroadcastMac(m: Mac) { return m === BROADCAST_MAC; }
export function isMulticastMac(m: Mac) { return (parseInt(m.slice(0, 2), 16) & 1) === 1; }
export function isValidMac(m: string) { return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(m); }

// ---- IPv4 ----
export type IPv4 = string; // dotted quad
export function ipToU32(ip: IPv4): number {
  const p = ip.split('.'); if (p.length !== 4) throw new Error(`bad ip ${ip}`);
  let v = 0; for (const x of p) { const n = Number(x); if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`bad ip ${ip}`); v = ((v << 8) | n) >>> 0; } return v;
}
export function u32ToIp(v: number): IPv4 { return `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`; }
export function isValidIp(s: string) { try { ipToU32(s); return true; } catch { return false; } }
export function prefixToMask(prefix: number): number { return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; }
export function maskToPrefix(mask: number): number { let n = 0; let m = mask >>> 0; while (m & 0x80000000) { n++; m = (m << 1) >>> 0; } return n; }
export function parseCidr(s: string): { ip: number; mask: number } {
  const [ip, pre] = s.split('/'); const p = pre === undefined ? 32 : Number(pre);
  return { ip: ipToU32(ip!), mask: prefixToMask(p) };
}
export function sameSubnet(a: number, b: number, mask: number) { return ((a & mask) >>> 0) === ((b & mask) >>> 0); }
export function broadcastOf(ip: number, mask: number) { return ((ip & mask) | (~mask >>> 0)) >>> 0; }
export const IP_BROADCAST = 0xffffffff;
