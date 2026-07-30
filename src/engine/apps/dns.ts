// DNS: authoritative servers (zones), recursive/caching resolver (iterative or forwarding),
// and a stub resolver used by dig/curl. Over UDP 53 (TCP 53 for truncated is future work).
import { u32ToIp, ipToU32, isValidIp } from '@/shared/bytes';
import { encodeDns, decodeDnsMessage, newQuery, DNS_A, DNS_NS, DNS_CNAME, DNS_SOA, RCODE_NXDOMAIN, RCODE_NOERROR, RCODE_SERVFAIL, RCODE_REFUSED, typeName, rdataStr, type DnsMessage, type DnsRecord, type DnsRData } from '../codecs/dns';
import { term } from '../devices/host';
import { udpSocket, udpSend } from '../stack/udp';
import { timer, rand, SEC, log } from '../core';
import type { EngineState, HostState, UdpSocket, DnsZoneRecord } from '../types';

// ---- zone parsing (simple RFC 1035-ish master file) ----
export function parseZone(origin: string, text: string): { records: DnsZoneRecord[]; error?: string } {
  const records: DnsZoneRecord[] = []; let defTtl = 3600; const o = origin.replace(/\.$/, '');
  const fqdn = (n: string) => n === '@' ? o : n.endsWith('.') ? n.slice(0, -1) : `${n}.${o}`;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/;.*$/, '').trim(); if (!line) continue;
    if (line.startsWith('$TTL')) { defTtl = Number(line.split(/\s+/)[1]) || defTtl; continue; }
    const p = line.split(/\s+/); let i = 0; const name = fqdn(p[i++]!); if (p[i] && /^\d+$/.test(p[i]!)) i++; if (p[i]?.toUpperCase() === 'IN') i++;
    const type = (p[i++] ?? '').toUpperCase(); const rest = p.slice(i);
    try {
      if (type === 'A') records.push({ name, type: DNS_A, ttl: defTtl, data: { kind: 'a', ip: ipToU32(rest[0]!) } });
      else if (type === 'NS') records.push({ name, type: DNS_NS, ttl: defTtl, data: { kind: 'ns', name: rest[0]!.replace(/\.$/, '') } });
      else if (type === 'CNAME') records.push({ name, type: DNS_CNAME, ttl: defTtl, data: { kind: 'cname', name: rest[0]!.replace(/\.$/, '') } });
      else if (type === 'MX') records.push({ name, type: 15, ttl: defTtl, data: { kind: 'mx', pref: Number(rest[0]), name: rest[1]!.replace(/\.$/, '') } });
      else if (type === 'TXT') records.push({ name, type: 16, ttl: defTtl, data: { kind: 'txt', text: rest.join(' ').replace(/^"|"$/g, '') } });
      else if (type === 'SOA') records.push({ name, type: DNS_SOA, ttl: defTtl, data: { kind: 'soa', mname: rest[0]!.replace(/\.$/, ''), rname: rest[1]!.replace(/\.$/, ''), serial: Number(rest[2] ?? 1), refresh: Number(rest[3] ?? 7200), retry: Number(rest[4] ?? 3600), expire: Number(rest[5] ?? 604800), minimum: Number(rest[6] ?? 3600) } });
    } catch { return { records, error: `bad record: ${line}` }; }
  }
  return { records };
}
export function ensureDnsSock(st: EngineState, h: HostState): number | null {
  if (h.dnsSock !== null && h.sockets[h.dnsSock]) return h.dnsSock;
  const s = udpSocket(h, -3, 53); if (typeof s === 'string') return null; (s as UdpSocket).localIp = null; h.dnsSock = s.id; return s.id;
}

// ---- authoritative answer from local zones ----
function inZone(name: string, origin: string) { return origin === '' || name === origin || name.endsWith('.' + origin); }
function authoritativeAnswer(h: HostState, q: { name: string; type: number }): DnsMessage | null {
  // Pick the most specific matching zone (longest origin).
  const zone = h.dnsZones.filter(z => inZone(q.name, z.origin)).sort((a, b) => b.origin.length - a.origin.length)[0]; if (!zone) return null;
  const m: DnsMessage = { id: 0, qr: true, opcode: 0, aa: true, tc: false, rd: false, ra: false, rcode: RCODE_NOERROR, questions: [{ name: q.name, type: q.type, cls: 1 }], answers: [], authority: [], additional: [] };
  const rec = (r: DnsZoneRecord): DnsRecord => ({ name: r.name, type: r.type, cls: 1, ttl: r.ttl, data: r.data });
  const addGlue = (nsName: string) => { const glue = zone.records.find(r => r.type === DNS_A && r.name === nsName); if (glue && !m.additional.some(x => x.name === nsName)) m.additional.push(rec(glue)); };
  let name = q.name; let hops = 0;
  while (hops++ < 8) {
    // Delegation to a deeper zone (NS record for a name below the apex that is at/above the query name).
    const deleg = zone.records.filter(r => r.type === DNS_NS && r.name !== zone.origin && r.name !== '' && (name === r.name || name.endsWith('.' + r.name))).sort((a, b) => b.name.length - a.name.length)[0];
    if (deleg) { m.aa = false; m.authority.push(rec(deleg)); addGlue((deleg.data as { kind: 'ns'; name: string }).name); return m; }
    const exact = zone.records.filter(r => r.name === name);
    const direct = exact.filter(r => r.type === q.type);
    if (direct.length) { m.answers.push(...direct.map(rec)); for (const d of direct) if (d.type === DNS_NS || d.type === 15) addGlue((d.data as { name: string }).name); break; }
    const cname = exact.find(r => r.type === DNS_CNAME);
    if (cname && q.type !== DNS_CNAME) { m.answers.push(rec(cname)); name = (cname.data as { kind: 'cname'; name: string }).name; if (!inZone(name, zone.origin)) break; continue; }
    if (!exact.length) { m.rcode = RCODE_NXDOMAIN; const soa = zone.records.find(r => r.type === DNS_SOA); if (soa) m.authority.push(rec(soa)); }
    break;
  }
  return m;
}

// ---- server socket dispatch (authoritative + optional recursion) ----
export function dnsServerRx(st: EngineState, h: HostState) {
  const sock = h.sockets[h.dnsSock!]; if (sock?.proto !== 'udp') return;
  for (const dg of sock.rx.splice(0)) {
    let query; try { query = decodeDnsMessage(dg.data, 0, dg.data.length); } catch { continue; }
    if (query.qr) { resolverOnResponse(st, h, query); continue; }
    const q = query.questions[0]; if (!q) continue;
    log(st, `${h.name}: DNS query ${typeName(q.type)} ${q.name} from ${u32ToIp(dg.src)}${query.rd ? ' (RD)' : ''}`);
    const auth = authoritativeAnswer(h, q);
    if (auth && (auth.answers.length || auth.authority.length || auth.rcode === RCODE_NXDOMAIN)) { auth.id = query.id; auth.rd = query.rd; auth.ra = h.dnsRecursion; reply(st, h, sock, dg.src, dg.sport, auth); continue; }
    if (query.rd && h.dnsRecursion) { startResolution(st, h, q.name, q.type, { client: dg.src, clientPort: dg.sport, id: query.id }); continue; }
    // no data and not recursive: REFUSED or empty NOERROR
    reply(st, h, sock, dg.src, dg.sport, { ...newQuery(query.id, q.name, q.type, false), qr: true, ra: h.dnsRecursion, rcode: h.dnsZones.length ? RCODE_NOERROR : RCODE_REFUSED });
  }
}
function reply(st: EngineState, h: HostState, sock: UdpSocket, dst: number, dport: number, m: DnsMessage) { const iface = h.ifaces.find(i => i.ip !== null); udpSend(st, h, sock, dst, dport, encodeDns(m), { src: iface?.ip ?? 0 }); }

// ---- recursive resolver with cache ----
export interface Resolution { name: string; type: number; qname: string; nsList: number[]; tried: Set<number>; client: number | null; clientPort: number; id: number; waiter: number | null; started: number; cnames: number; gen: number }
export function cacheGet(h: HostState, name: string, type: number, now: number): DnsRecord[] { const key = `${name}|${type}`; const e = h.dnsCache[key]; if (!e) return []; if (e.expires <= now) { delete h.dnsCache[key]; return []; } return e.records; }
function cachePut(h: HostState, name: string, type: number, records: DnsRecord[], now: number) { if (!records.length) return; const ttl = Math.max(1, Math.min(...records.map(r => r.ttl))); h.dnsCache[`${name}|${type}`] = { records, expires: now + ttl * SEC }; }
function startResolution(st: EngineState, h: HostState, name: string, type: number, who: { client: number | null; clientPort: number; id: number }): number {
  const cached = cacheGet(h, name, type, st.time);
  if (cached.length && who.client !== null) { const sock = h.sockets[h.dnsSock!]; if (sock?.proto === 'udp') { const m: DnsMessage = { id: who.id, qr: true, opcode: 0, aa: false, tc: false, rd: true, ra: true, rcode: RCODE_NOERROR, questions: [{ name, type, cls: 1 }], answers: cached, authority: [], additional: [] }; reply(st, h, sock, who.client, who.clientPort, m); } return -1; }
  const id = h.nextResolution++; const forwarders = h.dnsForwarders.length ? h.dnsForwarders : h.dnsRoots;
  const r: Resolution = { name, type, qname: name, nsList: [...forwarders], tried: new Set(), client: who.client, clientPort: who.clientPort, id: who.id, waiter: null, started: st.time, cnames: 0, gen: id };
  h.resolutions[id] = r; sendToNext(st, h, r); return id;
}
function sendToNext(st: EngineState, h: HostState, r: Resolution) {
  const sock = h.sockets[h.dnsSock!]; if (sock?.proto !== 'udp') return;
  const ns = r.nsList.find(n => !r.tried.has(n)); if (ns === undefined) { finishFail(st, h, r, RCODE_SERVFAIL); return; }
  r.tried.add(ns); r.waiter = ns;
  const iterative = !h.dnsForwarders.length; const q = newQuery(0x2000 + (r.gen & 0x1fff), r.qname, r.type, !iterative);
  log(st, `${h.name}: resolver → ${u32ToIp(ns)} ${iterative ? 'iterative' : 'recursive'} query ${typeName(r.type)} ${r.qname}`);
  const iface = h.ifaces.find(i => i.ip !== null); udpSend(st, h, sock, ns, 53, encodeDns(q), { src: iface?.ip ?? 0 });
  timer(st, h.id, 3 * SEC, `dns:${r.gen}:timeout`);
}
function resolverOnResponse(st: EngineState, h: HostState, m: DnsMessage) {
  const gen = m.id - 0x2000; const r = h.resolutions[gen] as Resolution | undefined; if (!r) return;
  for (const rr of [...m.answers, ...m.authority, ...m.additional]) if (rr.type === DNS_A) cachePut(h, rr.name, DNS_A, [rr], st.time);
  // CNAME chase
  const cname = m.answers.find(a => a.type === DNS_CNAME);
  const direct = m.answers.filter(a => a.type === r.type && a.name === r.qname);
  if (direct.length || (r.type !== DNS_A && m.answers.length)) { cachePut(h, r.name, r.type, m.answers, st.time); finishOk(st, h, r, m.answers); return; }
  if (cname && r.cnames < 8) { r.cnames++; r.qname = (cname.data as { kind: 'cname'; name: string }).name; const c2 = cacheGet(h, r.qname, r.type, st.time); if (c2.length) { finishOk(st, h, r, [cname, ...c2]); return; } r.nsList = [...(h.dnsForwarders.length ? h.dnsForwarders : h.dnsRoots)]; r.tried.clear(); sendToNext(st, h, r); return; }
  if (m.rcode === RCODE_NXDOMAIN) { finishFail(st, h, r, RCODE_NXDOMAIN); return; }
  // referral: follow NS glue (iterative mode)
  const glue = m.additional.filter(a => a.type === DNS_A).map(a => (a.data as { kind: 'a'; ip: number }).ip);
  if (glue.length) { r.nsList = glue; r.tried.clear(); sendToNext(st, h, r); return; }
  const nsNames = m.authority.filter(a => a.type === DNS_NS).map(a => (a.data as { kind: 'ns'; name: string }).name);
  if (nsNames.length) { const ips = nsNames.map(n => cacheGet(h, n, DNS_A, st.time)[0]).filter(Boolean).map(rr => (rr!.data as { kind: 'a'; ip: number }).ip); if (ips.length) { r.nsList = ips; r.tried.clear(); sendToNext(st, h, r); return; } }
  finishFail(st, h, r, RCODE_SERVFAIL);
}
function finishOk(st: EngineState, h: HostState, r: Resolution, answers: DnsRecord[]) { delete h.resolutions[r.gen]; deliver(st, h, r, { rcode: RCODE_NOERROR, answers }); }
function finishFail(st: EngineState, h: HostState, r: Resolution, rcode: number) { delete h.resolutions[r.gen]; deliver(st, h, r, { rcode, answers: [] }); }
function deliver(st: EngineState, h: HostState, r: Resolution, res: { rcode: number; answers: DnsRecord[] }) {
  if (r.client !== null) { const sock = h.sockets[h.dnsSock!]; if (sock?.proto === 'udp') { const m: DnsMessage = { id: r.id, qr: true, opcode: 0, aa: false, tc: false, rd: true, ra: true, rcode: res.rcode, questions: [{ name: r.name, type: r.type, cls: 1 }], answers: res.answers, authority: [], additional: [] }; reply(st, h, sock, r.client, r.clientPort, m); } }
  else { const w = h.dnsWaiters[r.gen]; if (w) { delete h.dnsWaiters[r.gen]; onResolved(st, h, w, res); } }
}
export function dnsTimer(st: EngineState, h: HostState, gen: number) { const r = h.resolutions[gen] as Resolution | undefined; if (!r) return; sendToNext(st, h, r); }

// ---- stub resolver used by dig / curl on a host ----
export function resolve(st: EngineState, h: HostState, name: string, type: number, waiter: import('../types').DnsWaiter) {
  if (isValidIp(name)) { onResolved(st, h, waiter, { rcode: RCODE_NOERROR, answers: [{ name, type: DNS_A, cls: 1, ttl: 0, data: { kind: 'a', ip: ipToU32(name) } }] }); return; }
  // /etc/hosts
  const hostEnt = h.hosts[name]; if (hostEnt !== undefined) { onResolved(st, h, waiter, { rcode: RCODE_NOERROR, answers: [{ name, type: DNS_A, cls: 1, ttl: 0, data: { kind: 'a', ip: hostEnt } }] }); return; }
  const server = h.dns[0] ? ipToU32(h.dns[0]) : null;
  if (server === null) { onResolved(st, h, waiter, { rcode: RCODE_SERVFAIL, answers: [] }); return; }
  ensureDnsSock(st, h); const gen = h.nextResolution++; h.dnsWaiters[gen] = waiter;
  const r: Resolution = { name, type, qname: name, nsList: [server], tried: new Set([server]), client: null, clientPort: 0, id: 0x2000 + (gen & 0x1fff), waiter: server, started: st.time, cnames: 0, gen };
  h.resolutions[gen] = r; const sock = h.sockets[h.dnsSock!]!; const iface = h.ifaces.find(i => i.ip !== null);
  udpSend(st, h, sock as UdpSocket, server, 53, encodeDns(newQuery(r.id, name, type, true)), { src: iface?.ip ?? 0 });
  timer(st, h.id, 5 * SEC, `dns:${gen}:timeout`);
}
export function digReport(h: HostState, name: string, type: number, res: { rcode: number; answers: DnsRecord[] }, serverIp: string, ms: number, auth: boolean) {
  term(h, `; <<>> NetSim dig <<>> ${typeName(type)} ${name}`); term(h, `;; ->>HEADER<<- opcode: QUERY, status: ${['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED'][res.rcode] ?? res.rcode}`);
  term(h, `;; ${auth ? 'AUTHORITATIVE' : 'NON-AUTHORITATIVE'} ANSWER:`); term(h, `;; QUESTION SECTION:`); term(h, `;${name}.\t\tIN\t${typeName(type)}`);
  if (res.answers.length) { term(h, ``); term(h, `;; ANSWER SECTION:`); for (const a of res.answers) term(h, `${a.name}.\t${a.ttl}\tIN\t${typeName(a.type)}\t${rdataStr(a.data)}`); }
  term(h, ``); term(h, `;; Query time: ${ms.toFixed(0)} msec`); term(h, `;; SERVER: ${serverIp}#53`);
}
export function firstA(res: { answers: DnsRecord[] }): number | null { const a = res.answers.find(x => x.type === DNS_A); return a ? (a.data as { kind: 'a'; ip: number }).ip : null; }
type ResolvedActions = {
  dig: (st: EngineState, h: HostState, w: Extract<import('../types').DnsWaiter, { kind: 'dig' }>, res: { rcode: number; answers: DnsRecord[] }) => void;
  ping: (st: EngineState, h: HostState, w: Extract<import('../types').DnsWaiter, { kind: 'ping' }>, res: { rcode: number; answers: DnsRecord[] }) => void;
  traceroute: (st: EngineState, h: HostState, w: Extract<import('../types').DnsWaiter, { kind: 'traceroute' }>, res: { rcode: number; answers: DnsRecord[] }) => void;
  http: (st: EngineState, h: HostState, w: Extract<import('../types').DnsWaiter, { kind: 'http' }>, res: { rcode: number; answers: DnsRecord[] }) => void;
};
let resolvedActions: ResolvedActions | null = null;
export function registerResolvedActions(a: ResolvedActions) { resolvedActions = a; }
function onResolved(st: EngineState, h: HostState, w: import('../types').DnsWaiter, res: { rcode: number; answers: DnsRecord[] }) {
  if (!resolvedActions) return; resolvedActions[w.kind](st, h, w as never, res);
}
export function isDnsSock(h: HostState, sockId: number) { return h.dnsSock === sockId; }
void RCODE_REFUSED;
