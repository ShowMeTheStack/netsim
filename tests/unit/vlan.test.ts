import { describe, it, expect } from 'vitest';
import { createState, addHost, addSwitch, connect, setIfaceIp, advance } from '@/engine/engine';
import { runCommand } from '@/engine/terminal';
import { DEFAULT_SWITCH_SCRIPT } from '@/engine/devices/switch-script';
import { ipToU32, prefixToMask } from '@/shared/bytes';
import { decodeFrame, fieldValue } from '@/engine/codecs/decode';
import { SEC } from '@/engine/core';
import type { EngineState, HostState, SwitchState } from '@/engine/types';
const ip = ipToU32; const m24 = prefixToMask(24);
const out = (h: HostState) => h.terminal.join('\n');
const run = (st: EngineState, s: number) => advance(st, st.time + s * SEC, 5e6);

// 4 hosts on one switch: A,B in VLAN 10; C,D in VLAN 20
function vlanLan() {
  const st = createState(1); const sw = addSwitch(st, 0, 0, 8); const hosts = ['A', 'B', 'C', 'D'].map((n, i) => { const h = addHost(st, 'laptop', 0, 0, n); connect(st, h.id, 0, sw.id, i); setIfaceIp(st, h, 'eth0', ip(`10.0.0.${i + 1}`), m24); return h; });
  sw.vlanEnabled = true; sw.ports[0]!.vlan = 10; sw.ports[1]!.vlan = 10; sw.ports[2]!.vlan = 20; sw.ports[3]!.vlan = 20;
  return { st, sw, A: hosts[0]!, B: hosts[1]!, C: hosts[2]!, D: hosts[3]! };
}

describe('VLANs', () => {
  it('same-VLAN hosts communicate; cross-VLAN is isolated', () => {
    const { st, A } = vlanLan(); runCommand(st, A, 'ping -c 2 10.0.0.2'); run(st, 10); expect(out(A)).toContain('2 packets transmitted, 2 received'); // A→B same VLAN 10
    const { st: st2, A: A2 } = vlanLan(); runCommand(st2, A2, 'ping -c 2 10.0.0.3'); run(st2, 12); expect(out(A2)).toContain('0 received'); // A(vlan10)→C(vlan20) blocked
  });
  it('trunk carries tagged frames between two switches, keeping VLANs separate', () => {
    const st = createState(1); const sw1 = addSwitch(st, 0, 0, 8); const sw2 = addSwitch(st, 0, 0, 8);
    const trunk = connect(st, sw1.id, 7, sw2.id, 7)!;
    const A = addHost(st, 'laptop', 0, 0, 'A'); const B = addHost(st, 'laptop', 0, 0, 'B'); connect(st, A.id, 0, sw1.id, 0); connect(st, B.id, 0, sw2.id, 0);
    setIfaceIp(st, A, 'eth0', ip('10.0.0.1'), m24); setIfaceIp(st, B, 'eth0', ip('10.0.0.2'), m24);
    for (const sw of [sw1, sw2]) { sw.vlanEnabled = true; sw.ports[0]!.vlan = 10; sw.ports[7]!.mode = 'trunk'; sw.ports[7]!.trunkVlans = [10, 20]; }
    const sn = addSnifferLocal(st, trunk);
    runCommand(st, A, 'ping -c 1 10.0.0.2'); run(st, 8);
    expect(out(A)).toContain('1 packets transmitted, 1 received');
    const tagged = st.sniffers[sn]!.frames.map(f => decodeFrame(f.bytes)).filter(f => f.layers.some(l => l.proto === 'vlan'));
    expect(tagged.length).toBeGreaterThan(0); expect(tagged.every(f => fieldValue(f, 'vlan.vid') === 10)).toBe(true);
  });
});
function addSnifferLocal(st: EngineState, link: number) { const id = st.nextSnifferId++; st.sniffers[id] = { id, linkId: link, frames: [], nextN: 1, captureFilter: '', maxFrames: 5000, total: 0 }; return id; }

describe('editable switch script', () => {
  it('the default script reproduces learn-and-flood behavior', () => {
    const st = createState(1); const sw = addSwitch(st, 0, 0); sw.script = DEFAULT_SWITCH_SCRIPT;
    const A = addHost(st, 'laptop', 0, 0, 'A'); const B = addHost(st, 'laptop', 0, 0, 'B'); connect(st, A.id, 0, sw.id, 0); connect(st, B.id, 0, sw.id, 1);
    setIfaceIp(st, A, 'eth0', ip('10.0.0.1'), m24); setIfaceIp(st, B, 'eth0', ip('10.0.0.2'), m24);
    runCommand(st, A, 'ping -c 2 10.0.0.2'); run(st, 10);
    expect(out(A)).toContain('2 packets transmitted, 2 received'); expect(Object.keys(sw.macTable).length).toBe(2);
  });
  it('a hub script (always flood) still delivers; a black-hole script (always drop) does not', () => {
    const mk = (script: string) => { const st = createState(1); const sw = addSwitch(st, 0, 0); sw.script = script; const A = addHost(st, 'laptop', 0, 0, 'A'); const B = addHost(st, 'laptop', 0, 0, 'B'); connect(st, A.id, 0, sw.id, 0); connect(st, B.id, 0, sw.id, 1); setIfaceIp(st, A, 'eth0', ip('10.0.0.1'), m24); setIfaceIp(st, B, 'eth0', ip('10.0.0.2'), m24); runCommand(st, A, 'ping -c 1 10.0.0.2'); run(st, 8); return out(A); };
    expect(mk('api.flood();')).toContain('1 received');
    expect(mk('api.drop();')).toContain('0 received');
  });
  it('a malicious script cannot touch the outside world and is contained', () => {
    const st = createState(1); const sw = addSwitch(st, 0, 0); sw.script = 'api.flood(); if (typeof fetch !== "undefined") api.log("HAS FETCH"); if (typeof globalThis !== "undefined") api.log("HAS GLOBAL");';
    const A = addHost(st, 'laptop', 0, 0, 'A'); const B = addHost(st, 'laptop', 0, 0, 'B'); connect(st, A.id, 0, sw.id, 0); connect(st, B.id, 0, sw.id, 1);
    setIfaceIp(st, A, 'eth0', ip('10.0.0.1'), m24); setIfaceIp(st, B, 'eth0', ip('10.0.0.2'), m24);
    runCommand(st, A, 'ping -c 1 10.0.0.2'); run(st, 8);
    expect(out(A)).toContain('1 received'); // still forwards
    expect(st.log.some(l => l.text.includes('HAS FETCH') || l.text.includes('HAS GLOBAL'))).toBe(false); // globals shadowed
  });
})
