// HTTP/1.x message parsing (text over the TCP byte stream) and simple HTML resource extraction.
export interface HttpRequest { method: string; target: string; version: string; headers: Record<string, string>; body: Uint8Array }
export interface HttpResponse { version: string; status: number; reason: string; headers: Record<string, string>; body: Uint8Array }
const dec = new TextDecoder(); const enc = new TextEncoder();

function findHeaderEnd(b: Uint8Array): number { for (let i = 3; i < b.length; i++) if (b[i - 3] === 13 && b[i - 2] === 10 && b[i - 1] === 13 && b[i] === 10) return i + 1; return -1; }
function parseHeaders(lines: string[]): Record<string, string> { const h: Record<string, string> = {}; for (const l of lines) { const c = l.indexOf(':'); if (c > 0) h[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim(); } return h; }
/** Returns [message, bytesConsumed] or null if more data is needed. */
export function parseRequest(buf: Uint8Array): [HttpRequest, number] | null {
  const he = findHeaderEnd(buf); if (he < 0) return null;
  const head = dec.decode(buf.subarray(0, he)).split('\r\n'); const [method, target, version] = (head[0] ?? '').split(' ');
  const headers = parseHeaders(head.slice(1)); const len = Number(headers['content-length'] ?? 0);
  if (buf.length < he + len) return null;
  return [{ method: method ?? 'GET', target: target ?? '/', version: version ?? 'HTTP/1.1', headers, body: buf.slice(he, he + len) }, he + len];
}
export function parseResponse(buf: Uint8Array, headOnly = false): [HttpResponse, number] | null {
  const he = findHeaderEnd(buf); if (he < 0) return null;
  if (headOnly) { const head = dec.decode(buf.subarray(0, he)).split('\r\n'); const m = /^(HTTP\/\d\.\d)\s+(\d+)\s*(.*)$/.exec(head[0] ?? ''); return [{ version: m?.[1] ?? 'HTTP/1.1', status: Number(m?.[2] ?? 0), reason: m?.[3] ?? '', headers: parseHeaders(head.slice(1)), body: new Uint8Array(0) }, he]; }
  const head = dec.decode(buf.subarray(0, he)).split('\r\n'); const m = /^(HTTP\/\d\.\d)\s+(\d+)\s*(.*)$/.exec(head[0] ?? '');
  const headers = parseHeaders(head.slice(1));
  if (headers['transfer-encoding']?.toLowerCase() === 'chunked') { const r = parseChunked(buf, he); if (!r) return null; return [{ version: m?.[1] ?? 'HTTP/1.1', status: Number(m?.[2] ?? 0), reason: m?.[3] ?? '', headers, body: r[0] }, r[1]]; }
  const len = Number(headers['content-length'] ?? 0); if (buf.length < he + len) return null;
  return [{ version: m?.[1] ?? 'HTTP/1.1', status: Number(m?.[2] ?? 0), reason: m?.[3] ?? '', headers, body: buf.slice(he, he + len) }, he + len];
}
function parseChunked(buf: Uint8Array, start: number): [Uint8Array, number] | null {
  let p = start; const chunks: Uint8Array[] = [];
  for (;;) { let nl = -1; for (let i = p; i < buf.length - 1; i++) if (buf[i] === 13 && buf[i + 1] === 10) { nl = i; break; } if (nl < 0) return null; const size = parseInt(dec.decode(buf.subarray(p, nl)) || '0', 16); p = nl + 2; if (size === 0) { return [concatChunks(chunks), p + 2]; } if (buf.length < p + size + 2) return null; chunks.push(buf.slice(p, p + size)); p += size + 2; }
}
function concatChunks(cs: Uint8Array[]) { let n = 0; for (const c of cs) n += c.length; const o = new Uint8Array(n); let x = 0; for (const c of cs) { o.set(c, x); x += c.length; } return o; }
export function encodeRequest(r: HttpRequest): Uint8Array {
  let s = `${r.method} ${r.target} ${r.version}\r\n`; for (const [k, v] of Object.entries(r.headers)) s += `${k}: ${v}\r\n`; if (r.body.length && !('content-length' in r.headers)) s += `Content-Length: ${r.body.length}\r\n`; s += '\r\n';
  return concatChunks([enc.encode(s), r.body]);
}
export function encodeResponse(r: HttpResponse): Uint8Array {
  let s = `${r.version} ${r.status} ${r.reason}\r\n`; for (const [k, v] of Object.entries(r.headers)) s += `${k}: ${v}\r\n`; s += '\r\n';
  return concatChunks([enc.encode(s), r.body]);
}
export function statusReason(code: number) { return ({ 200: 'OK', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error', 501: 'Not Implemented' } as Record<number, string>)[code] ?? 'Unknown'; }
/** Extract same-origin sub-resource paths from an HTML body (img/script/link[stylesheet]). */
export function extractResources(html: string): string[] {
  const out: string[] = []; const re = /<(img|script|link)\b[^>]*>/gi; let m;
  while ((m = re.exec(html))) { const tag = m[0]; const tagName = m[1]!.toLowerCase(); if (tagName === 'link' && !/rel\s*=\s*['"]?stylesheet/i.test(tag)) continue; const attr = tagName === 'link' ? 'href' : 'src'; const a = new RegExp(attr + "\\s*=\\s*['\"]([^'\"]+)['\"]", 'i').exec(tag); if (a && a[1] && !/^https?:|^\/\/|^data:|^#/i.test(a[1]!)) out.push(a[1]!); }
  return [...new Set(out)];
}
export function contentType(path: string): string { const ext = path.split('.').pop()?.toLowerCase(); return ({ html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', txt: 'text/plain', ico: 'image/x-icon' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream'; }
