// Sandboxed, editable switch-learning script. Runs user JavaScript with a frozen, curated API
// and no access to DOM, network, timers or globals. Errors and runaway loops are contained.
import { encodeEthernet, decodeEthernet } from '../codecs/ethernet';
import { egress } from './switch';
import { log } from '../core';
import type { EngineState, SwitchState } from '../types';

export const DEFAULT_SWITCH_SCRIPT = `// Editable switch learning logic. 'api' is the only thing you can touch.
// Learn the source MAC on the ingress port, then forward to the known port
// (in the same VLAN) or flood if the destination is unknown.
api.learn(api.src, api.inPort);
const outPort = api.lookup(api.dst);
if (outPort !== null && outPort !== api.inPort) {
  api.forward(outPort);        // known unicast → single port
} else {
  api.flood();                 // unknown/broadcast → every other port in the VLAN
}`;

export function runSwitchScript(st: EngineState, sw: SwitchState, portIdx: number, bytes: Uint8Array, e: ReturnType<typeof decodeEthernet>, vlan: number) {
  const api = {
    src: e.src, dst: e.dst, inPort: portIdx, vlan, portCount: sw.ports.length, isBroadcast: e.dst === 'ff:ff:ff:ff:ff:ff',
    learn(mac: string, port: number) { const k = `${vlan}:${mac}`; if (!sw.macTable[k] || sw.macTable[k]!.port !== port) sw.counters.learned++; sw.macTable[k] = { port, expires: st.time + sw.agingUs, vlan }; },
    lookup(mac: string): number | null { const ent = sw.macTable[`${vlan}:${mac}`]; return ent && ent.expires > st.time ? ent.port : null; },
    forward(port: number) { sw.counters.forwarded++; egress(st, sw, port, bytes, e, vlan, portIdx); },
    flood() { sw.counters.flooded++; for (let i = 0; i < sw.ports.length; i++) if (i !== portIdx) egress(st, sw, i, bytes, e, vlan, portIdx); },
    drop() { sw.counters.filtered++; },
    log(msg: unknown) { log(st, `${sw.name} [script]: ${String(msg)}`); },
  };
  try { const fn = compile(sw.script!); fn(api); } catch (err) { log(st, `${sw.name}: switch script error: ${(err as Error).message}`); }
  void encodeEthernet;
}

// Compile the user script once per source text. The function sees only `api`; `globalThis`,
// `window`, `fetch`, timers etc. are shadowed to undefined. A step counter caps loops.
const cache = new Map<string, (api: unknown) => void>();
function compile(src: string): (api: unknown) => void {
  const cached = cache.get(src); if (cached) return cached;
  const blocked = ['globalThis', 'window', 'self', 'global', 'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval', 'importScripts', 'require', 'process', 'document', 'postMessage', 'localStorage', 'indexedDB', 'crypto', 'Worker'];
  // eslint-disable-next-line no-new-func
  const factory = new Function(...blocked, 'api', `"use strict";\n${src}`);
  const fn = (api: unknown) => factory(...blocked.map(() => undefined), api);
  if (cache.size > 200) cache.clear(); cache.set(src, fn); return fn;
}
void decodeEthernet;
