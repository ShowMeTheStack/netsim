// Learning switch with 802.1Q VLAN support and an optional editable learning script.
// Default behavior: learn source MAC per (VLAN), forward to the known port in the same VLAN,
// else flood within the VLAN. Access ports carry one untagged VLAN; trunk ports carry 802.1Q tags.
import { decodeEthernet, encodeEthernet, ETH_MIN_FRAME } from '../codecs/ethernet';
import { isMulticastMac, type Mac } from '@/shared/bytes';
import { nicTx } from '../link';
import { log } from '../core';
import { runSwitchScript } from './switch-script';
import type { EngineState, SwitchState, SwitchPort } from '../types';

/** VLAN of an ingress frame given the port: access → port VLAN; trunk → the 802.1Q tag (or native 1). */
function ingressVlan(sw: SwitchState, port: SwitchPort, tagged: number | undefined): number {
  if (!sw.vlanEnabled) return 1;
  if (port.mode === 'trunk') return tagged ?? 1;
  return port.vlan;
}
function vlanAllowedOnPort(sw: SwitchState, port: SwitchPort, vlan: number): boolean {
  if (!sw.vlanEnabled) return true;
  if (port.mode === 'access') return port.vlan === vlan;
  return port.trunkVlans.length === 0 || port.trunkVlans.includes(vlan);
}

export function switchRx(st: EngineState, sw: SwitchState, portIdx: number, bytes: Uint8Array) {
  const port = sw.ports[portIdx]; if (!port || !port.up) return; port.rxPackets++;
  let e; try { e = decodeEthernet(bytes); } catch { port.rxDrops++; return; }
  if (!e.fcsOk) { port.rxDrops++; log(st, `${sw.name}: dropped frame with bad FCS on ${port.name}`); return; }
  const vlan = ingressVlan(sw, port, e.vid);
  if (sw.vlanEnabled && port.mode === 'trunk' && e.vid === undefined && !port.trunkVlans.includes(1)) { port.rxDrops++; return; }
  if (sw.vlanEnabled && !vlanAllowedOnPort(sw, port, vlan)) { port.rxDrops++; return; }

  if (sw.script) { runSwitchScript(st, sw, portIdx, bytes, e, vlan); return; }

  // ---- default learn-and-forward (per VLAN) ----
  const known = sw.macTable[macKey(e.src, vlan)];
  if (!known || known.port !== portIdx) { sw.counters.learned++; log(st, `${sw.name}: learned ${e.src} on ${port.name}${sw.vlanEnabled ? ` vlan ${vlan}` : ''}`); }
  sw.macTable[macKey(e.src, vlan)] = { port: portIdx, expires: st.time + sw.agingUs, vlan };
  const dst = sw.macTable[macKey(e.dst, vlan)];
  if (dst && dst.expires > st.time && !isMulticastMac(e.dst)) {
    if (dst.port === portIdx) { sw.counters.filtered++; return; }
    sw.counters.forwarded++; egress(st, sw, dst.port, bytes, e, vlan, portIdx); return;
  }
  sw.counters.flooded++;
  for (let i = 0; i < sw.ports.length; i++) if (i !== portIdx) egress(st, sw, i, bytes, e, vlan, portIdx);
}
function macKey(mac: Mac, vlan: number) { return `${vlan}:${mac}`; }

/** Send a frame out a port, adding/stripping the 802.1Q tag as the port mode requires. */
export function egress(st: EngineState, sw: SwitchState, portIdx: number, bytes: Uint8Array, e: ReturnType<typeof decodeEthernet>, vlan: number, inPort: number) {
  const p = sw.ports[portIdx]; if (!p || !p.up || p.linkId === null) return;
  if (sw.vlanEnabled && !vlanAllowedOnPort(sw, p, vlan)) return; void inPort;
  let outBytes = bytes;
  if (sw.vlanEnabled) {
    const wantTag = p.mode === 'trunk'; const hasTag = e.vid !== undefined;
    if (wantTag !== hasTag || (wantTag && e.vid !== vlan)) outBytes = retag(bytes, e, wantTag ? vlan : undefined);
  }
  p.txPackets++; nicTx(st, sw.id, portIdx, outBytes);
}
/** Rebuild a frame with (or without) an 802.1Q tag. */
function retag(bytes: Uint8Array, e: ReturnType<typeof decodeEthernet>, vlan: number | undefined): Uint8Array {
  const payload = bytes.subarray(e.payloadStart, e.payloadEnd);
  return encodeEthernet({ dst: e.dst, src: e.src, ethertype: e.ethertype, payload, ...(vlan !== undefined ? { vlan: { vid: vlan } } : {}) });
}
export function switchExpireMacs(sw: SwitchState, now: number) { for (const [m, ent] of Object.entries(sw.macTable)) if (ent.expires <= now) delete sw.macTable[m]; }
export { ETH_MIN_FRAME };
