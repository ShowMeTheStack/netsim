// Wires DNS stub-resolver completions to their actions. Imported for its side effect so that
// resolution results (dig / ping / traceroute / http-client) are dispatched without storing
// any closures in engine state (state stays structured-cloneable).
import { registerResolvedActions, digReport, firstA } from './dns';
import { startPing } from './ping';
import { startTraceroute } from './traceroute';
import { httpResolved } from './http';
import { term, lookupRoute } from '../devices/host';
import { u32ToIp } from '@/shared/bytes';
import type { EngineState, HostState } from '../types';

registerResolvedActions({
  dig: (_st, h, w, res) => digReport(h, w.name, w.type, res, w.serverIp, (_st.time - w.t0) / 1000, false),
  ping: (st, h, w, res) => { const ip = firstA(res); if (ip === null) { term(h, `ping: ${w.name}: Name or service not known`); return; } term(h, `${w.name} resolved to ${u32ToIp(ip)}`); if (!lookupRoute(h, ip)) { term(h, `ping: connect: Network is unreachable`); return; } startPing(st, h, ip, w.opts); },
  traceroute: (st, h, w, res) => { const ip = firstA(res); if (ip === null) { term(h, `traceroute: ${w.name}: Name or service not known`); return; } term(h, `${w.name} resolved to ${u32ToIp(ip)}`); if (!lookupRoute(h, ip)) { term(h, `traceroute: Network is unreachable`); return; } const r = startTraceroute(st, h, ip, w.opts); if (typeof r === 'string') term(h, `traceroute: ${r}`); },
  http: (st, h, w, res) => httpResolved(st, h, w.pid, w.path, w.host, w.port, firstA(res)),
});
void ((_: EngineState, __: HostState) => 0);
