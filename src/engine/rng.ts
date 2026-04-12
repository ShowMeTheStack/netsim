// Seeded, serializable PRNG (xoshiro128**). State is four uint32s: plain data.
export interface RngState { a: number; b: number; c: number; d: number }

export function seedRng(seed: number): RngState {
  // splitmix32 to expand the seed
  let s = seed >>> 0; const next = () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0; z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0; return (z ^ (z >>> 16)) >>> 0; };
  const st = { a: next(), b: next(), c: next(), d: next() };
  if ((st.a | st.b | st.c | st.d) === 0) st.a = 1;
  return st;
}
function rotl(x: number, k: number) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
export function nextU32(st: RngState): number {
  const result = Math.imul(rotl(Math.imul(st.b, 5) >>> 0, 7), 9) >>> 0;
  const t = (st.b << 9) >>> 0;
  st.c ^= st.a; st.d ^= st.b; st.b ^= st.c; st.a ^= st.d; st.c ^= t; st.d = rotl(st.d, 11);
  st.a >>>= 0; st.b >>>= 0; st.c >>>= 0; st.d >>>= 0;
  return result;
}
export function nextFloat(st: RngState): number { return nextU32(st) / 4294967296; }
export function nextInt(st: RngState, maxExclusive: number): number { return Math.floor(nextFloat(st) * maxExclusive); }
export function nextRange(st: RngState, min: number, max: number): number { return min + nextFloat(st) * (max - min); }
