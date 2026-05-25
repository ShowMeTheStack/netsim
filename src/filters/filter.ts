// Wireshark-like filter language shared by capture filters, display filters and breakpoints.
// Grammar: or := and ('or' and)* ; and := not ('and' not)* ; not := 'not' not | primary
// primary := '(' or ')' | key op value | key 'in' '{' v v ... '}' | key 'contains' value | key
import type { DecodedFrame } from '@/engine/codecs/types';
import { fieldValue } from '@/engine/codecs/decode';
import { ipToU32, isValidIp, prefixToMask } from '@/shared/bytes';

type Tok = { k: 'ident' | 'num' | 'str' | 'op' | 'lp' | 'rp' | 'lb' | 'rb' | 'eof'; v: string };
function lex(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ k: 'lp', v: c }); i++; continue; }
    if (c === ')') { out.push({ k: 'rp', v: c }); i++; continue; }
    if (c === '{') { out.push({ k: 'lb', v: c }); i++; continue; }
    if (c === '}') { out.push({ k: 'rb', v: c }); i++; continue; }
    if (c === '"' || c === "'") { let j = i + 1, s = ''; while (j < src.length && src[j] !== c) s += src[j++]; out.push({ k: 'str', v: s }); i = j + 1; continue; }
    const m = /^(==|!=|<=|>=|<|>|&&|\|\||!)/.exec(src.slice(i)); if (m) { out.push({ k: 'op', v: m[0] }); i += m[0].length; continue; }
    const w = /^[A-Za-z0-9_.:\/\-]+/.exec(src.slice(i)); if (w) { const v = w[0]; out.push({ k: /^(0x[0-9a-f]+|\d+)$/i.test(v) ? 'num' : 'ident', v }); i += v.length; continue; }
    throw new Error(`Unexpected character '${c}' at ${i}`);
  }
  out.push({ k: 'eof', v: '' }); return out;
}

export type Ast =
  | { t: 'or'; a: Ast; b: Ast } | { t: 'and'; a: Ast; b: Ast } | { t: 'not'; a: Ast }
  | { t: 'cmp'; key: string; op: string; val: string }
  | { t: 'in'; key: string; vals: string[] } | { t: 'contains'; key: string; val: string } | { t: 'has'; key: string };

export function parseFilter(src: string): Ast | null {
  if (!src.trim()) return null;
  const toks = lex(src); let p = 0;
  const peek = () => toks[p]!; const next = () => toks[p++]!;
  const isWord = (w: string) => peek().k === 'ident' && peek().v.toLowerCase() === w;
  function or(): Ast { let a = and(); while (isWord('or') || (peek().k === 'op' && peek().v === '||')) { next(); a = { t: 'or', a, b: and() }; } return a; }
  function and(): Ast { let a = not(); while (isWord('and') || (peek().k === 'op' && peek().v === '&&')) { next(); a = { t: 'and', a, b: not() }; } return a; }
  function not(): Ast { if (isWord('not') || (peek().k === 'op' && peek().v === '!')) { next(); return { t: 'not', a: not() }; } return primary(); }
  function primary(): Ast {
    const tk = next();
    if (tk.k === 'lp') { const e = or(); if (next().k !== 'rp') throw new Error('Expected )'); return e; }
    if (tk.k !== 'ident') throw new Error(`Unexpected '${tk.v}'`);
    const key = tk.v; const n = peek();
    const wordOps: Record<string, string> = { eq: '==', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=' };
    if (n.k === 'op' && n.v !== '!' && n.v !== '&&' && n.v !== '||') { next(); const v = next(); if (v.k !== 'ident' && v.k !== 'num' && v.k !== 'str') throw new Error('Expected value'); return { t: 'cmp', key, op: n.v, val: v.v }; }
    if (n.k === 'ident' && wordOps[n.v.toLowerCase()]) { next(); const v = next(); return { t: 'cmp', key, op: wordOps[n.v.toLowerCase()]!, val: v.v }; }
    if (n.k === 'ident' && n.v.toLowerCase() === 'in') { next(); if (next().k !== 'lb') throw new Error('Expected {'); const vals: string[] = []; while (peek().k !== 'rb') { const v = next(); if (v.k === 'eof') throw new Error('Expected }'); vals.push(v.v); } next(); return { t: 'in', key, vals }; }
    if (n.k === 'ident' && n.v.toLowerCase() === 'contains') { next(); const v = next(); return { t: 'contains', key, val: v.v }; }
    return { t: 'has', key };
  }
  const ast = or(); if (peek().k !== 'eof') throw new Error(`Unexpected '${peek().v}'`); return ast;
}

function toNum(v: unknown): number | null { if (typeof v === 'number') return v; if (typeof v === 'boolean') return v ? 1 : 0; if (typeof v === 'string') { if (/^0x[0-9a-f]+$/i.test(v)) return parseInt(v, 16); if (/^-?\d+$/.test(v)) return Number(v); } return null; }
function matchOne(actual: unknown, op: string, lit: string): boolean {
  if (actual === undefined || actual === null) return false;
  // CIDR match for ip fields
  if (typeof actual === 'string' && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(lit) && isValidIp(actual)) {
    const [ip, pre] = lit.split('/'); const mask = prefixToMask(Number(pre)); const inside = ((ipToU32(actual) & mask) >>> 0) === ((ipToU32(ip!) & mask) >>> 0);
    return op === '==' ? inside : op === '!=' ? !inside : false;
  }
  if (typeof actual === 'boolean') { const l = lit.toLowerCase(); const lb = l === 'true' || l === '1'; return op === '==' ? actual === lb : op === '!=' ? actual !== lb : false; }
  const an = toNum(actual), ln = toNum(lit);
  if (an !== null && ln !== null && typeof actual !== 'string') { switch (op) { case '==': return an === ln; case '!=': return an !== ln; case '<': return an < ln; case '>': return an > ln; case '<=': return an <= ln; case '>=': return an >= ln; } }
  const as = String(actual).toLowerCase(), ls = lit.toLowerCase();
  switch (op) { case '==': return as === ls; case '!=': return as !== ls; case '<': return as < ls; case '>': return as > ls; case '<=': return as <= ls; case '>=': return as >= ls; }
  return false;
}
function cmp(actual: unknown, op: string, lit: string): boolean {
  if (Array.isArray(actual)) return op === '!=' ? actual.every(a => matchOne(a, op, lit)) : actual.some(a => matchOne(a, op, lit));
  return matchOne(actual, op, lit);
}

export function evalFilter(ast: Ast | null, d: DecodedFrame): boolean {
  if (!ast) return true;
  switch (ast.t) {
    case 'or': return evalFilter(ast.a, d) || evalFilter(ast.b, d);
    case 'and': return evalFilter(ast.a, d) && evalFilter(ast.b, d);
    case 'not': return !evalFilter(ast.a, d);
    case 'has': { const v = fieldValue(d, ast.key); return v !== undefined && v !== false; }
    case 'cmp': return cmp(fieldValue(d, ast.key), ast.op, ast.val);
    case 'in': { const v = fieldValue(d, ast.key); return ast.vals.some(x => cmp(v, '==', x)); }
    case 'contains': { const v = fieldValue(d, ast.key); return v !== undefined && String(v).toLowerCase().includes(ast.val.toLowerCase()); }
  }
}

const cache = new Map<string, Ast | null | Error>();
/** Compile with memoization; returns Error for invalid expressions. */
export function compileFilter(src: string): Ast | null | Error {
  if (cache.has(src)) return cache.get(src)!;
  let r: Ast | null | Error; try { r = parseFilter(src); } catch (e) { r = e as Error; }
  if (cache.size > 500) cache.clear(); cache.set(src, r); return r;
}
