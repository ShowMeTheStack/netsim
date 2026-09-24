// Thorough per-lab verification: for EVERY lab, build its topology, apply the intended solution
// (the same actions its steps describe), advance the simulation, and assert that ALL of its
// checks pass. This proves each of the 70 labs is genuinely completable, not merely well-formed.
import { describe, it, expect } from 'vitest';
import { ALL_LABS } from '@/ui/labs';
import { parseSession } from '@/session/session';
import { advance, ensureServices, addStaticRoute, setIfaceIp, setDefaultGateway, setWireless, evalCheck } from '@/engine/engine';
import { rebuildConnectedRoutes } from '@/engine/devices/host';
import { DEFAULT_SWITCH_SCRIPT } from '@/engine/devices/switch-script';
import { runCommand } from '@/engine/terminal';
import { ipToU32 as ip, prefixToMask as mask } from '@/shared/bytes';
import { SEC } from '@/engine/core';
import type { EngineState, HostState } from '@/engine/types';

type ByName = (n: string) => any;
function mk(labId: string) { const lab = ALL_LABS.find(l => l.id === labId)!; const st = parseSession(lab.build()).state; ensureServices(st); const byName: ByName = (n: string) => Object.values(st.nodes).find(x => x.name === n) as any; return { st, byName, lab }; }
const cmd = (st: EngineState, h: HostState, line: string) => runCommand(st, h, line);
const run = (st: EngineState, secs: number) => advance(st, st.time + secs * SEC, 8e6);
const down = (st: EngineState, h: HostState, iface: string) => { const i = h.ifaces.find(x => x.name === iface)!; i.up = false; rebuildConnectedRoutes(h); };
const linkByEnds = (st: EngineState, aName: string, bName: string) => { const a = Object.values(st.nodes).find(n => n.name === aName)!; const b = Object.values(st.nodes).find(n => n.name === bName)!; return Object.values(st.links).find(l => (l.a.node === a.id && l.b.node === b.id) || (l.a.node === b.id && l.b.node === a.id))!; };

// One solver per lab id. Each performs the lab's intended actions on the engine directly.
const SOLVERS: Record<string, (st: EngineState, b: ByName) => void> = {
  // ---- Getting Started ----
  'gs-first-ping': (st, b) => { cmd(st, b('PC-A'), 'ping -c 4 192.168.1.20'); run(st, 20); },
  'gs-sniffer': (st, b) => { cmd(st, b('PC-A'), 'ping -c 1 192.168.1.20'); run(st, 6); },
  'gs-filters': (st, b) => { cmd(st, b('PC-A'), 'ping -c 4 192.168.1.20'); run(st, 20); },
  'gs-stepping': (st, b) => { cmd(st, b('PC-A'), 'ping -c 1 192.168.1.20'); run(st, 6); },
  // ---- Physical & Data Link ----
  'link-coding': (st, b) => { cmd(st, b('PC-A'), 'ping -c 1 10.0.0.2'); run(st, 6); },
  'link-framing': (st, b) => { cmd(st, b('PC-A'), 'ping -c 1 10.0.0.2'); run(st, 6); },
  'link-fcs': (st, b) => { cmd(st, b('PC-A'), 'ping -c 2 10.0.0.2'); run(st, 10); const l = linkByEnds(st, 'PC-A', 'Switch1'); l.impair = { ...l.impair, corruptNext: 4, dir: 'both' }; cmd(st, b('PC-A'), 'ping -c 4 10.0.0.2'); run(st, 20); },
  'link-domains': (st, b) => { cmd(st, b('PC-A'), 'ping -c 1 10.0.0.2'); run(st, 6); cmd(st, b('PC-A'), 'ping -c 1 10.0.0.3'); run(st, 6); },
  // ---- Switching ----
  'sw-learning': (st, b) => { cmd(st, b('PC-A'), 'ping -c 3 10.0.0.2'); run(st, 12); },
  'sw-aging': (st, b) => { cmd(st, b('PC-A'), 'ping -c 2 10.0.0.2'); run(st, 10); },
  'sw-multi': (st, b) => { cmd(st, b('PC-A'), 'ping -c 3 10.0.0.4'); run(st, 12); },
  'sw-script': (st, b) => { const sw = b('Switch1'); sw.script = DEFAULT_SWITCH_SCRIPT; cmd(st, b('PC-A'), 'ping -c 2 10.0.0.2'); run(st, 12); },
  // ---- ARP ----
  'arp-resolve': (st, b) => { cmd(st, b('PC-A'), 'ping -c 1 10.0.0.2'); run(st, 6); },
  'arp-cache': (st, b) => { cmd(st, b('PC-A'), 'ping -c 1 10.0.0.2'); run(st, 6); },
  'arp-router': (st, b) => { cmd(st, b('PC-A'), 'ping -c 2 10.0.2.10'); run(st, 12); },
  // ---- VLANs ----
  'vlan-access': (st, b) => { cmd(st, b('PC-A'), 'ping -c 3 10.0.0.2'); run(st, 12); cmd(st, b('PC-A'), 'ping -c 3 10.0.0.3'); run(st, 20); },
  'vlan-trunk': (st, b) => { cmd(st, b('PC-A'), 'ping -c 3 10.0.0.2'); run(st, 12); },
  'vlan-intervlan': (st, b) => { cmd(st, b('PC-A'), 'ping -c 3 10.0.20.10'); run(st, 12); },
  // ---- IPv4 & Subnetting ----
  'ip-addressing': (st, b) => { const a = b('PC-A'), pb = b('PC-B'); setIfaceIp(st, a, 'eth0', ip('10.0.0.1'), mask(24)); setIfaceIp(st, pb, 'eth0', ip('10.0.0.2'), mask(24)); cmd(st, a, 'ping -c 2 10.0.0.2'); run(st, 12); },
  'ip-two-subnets': (st, b) => { cmd(st, b('PC-A'), 'ping -c 1 10.0.2.10'); run(st, 6); },
  'ip-gateway': (st, b) => { setDefaultGateway(b('PC-A'), ip('10.0.1.1')); setDefaultGateway(b('PC-B'), ip('10.0.2.1')); cmd(st, b('PC-A'), 'ping -c 3 10.0.2.10'); run(st, 12); },
  'ip-lpm': (st, b) => { addStaticRoute(b('R1'), ip('10.0.9.0'), mask(24), ip('10.0.12.2')); cmd(st, b('PC-A'), 'ping -c 3 10.0.9.10'); run(st, 14); },
  // ---- Fragmentation & ICMP ----
  'frag-basic': (st, b) => { cmd(st, b('PC-A'), 'ping -c 1 -s 1400 10.0.2.10'); run(st, 12); },
  'frag-pmtud': (st, b) => { cmd(st, b('PC-A'), 'ping -c 1 -M do -s 1400 10.0.2.10'); run(st, 12); },
  'icmp-traceroute': (st, b) => { cmd(st, b('PC-A'), 'ping -c 1 -t 1 10.0.2.10'); run(st, 8); cmd(st, b('PC-A'), 'traceroute 10.0.2.10'); run(st, 30); },
  // ---- Static Routing ----
  'static-2router': (st, b) => { addStaticRoute(b('R1'), ip('10.0.2.0'), mask(24), ip('10.0.12.2')); addStaticRoute(b('R2'), ip('10.0.1.0'), mask(24), ip('10.0.12.1')); cmd(st, b('PC-A'), 'ping -c 3 10.0.2.10'); run(st, 14); },
  'static-default': (st, b) => { setDefaultGateway(b('R1'), ip('10.0.12.2')); cmd(st, b('PC-A'), 'ping -c 3 10.0.2.10'); run(st, 14); },
  'static-multihop': (st, b) => { addStaticRoute(b('R1'), ip('10.0.3.0'), mask(24), ip('10.0.12.2')); addStaticRoute(b('R3'), ip('10.0.1.0'), mask(24), ip('10.0.23.2')); cmd(st, b('PC-A'), 'ping -c 2 10.0.3.10'); run(st, 16); },
  // ---- RIP ----
  'rip-basic': (st, b) => { run(st, 150); cmd(st, b('PC-A'), 'ping -c 3 10.0.9.10'); run(st, 20); },
  'rip-split-horizon': (st, b) => { run(st, 120); cmd(st, b('PC-A'), 'ping -c 2 10.0.2.10'); run(st, 20); },
  'rip-metric': (st, b) => { run(st, 150); cmd(st, b('PC-A'), 'ping -c 2 10.0.9.10'); run(st, 20); },
  'rip-failure': (st, b) => { run(st, 90); down(st, b('R1'), 'eth1'); run(st, 120); cmd(st, b('PC-A'), 'ping -c 3 10.0.9.10'); run(st, 40); },
  // ---- OSPF ----
  'ospf-adjacency': (st, b) => { run(st, 60); cmd(st, b('PC-A'), 'ping -c 3 10.0.9.10'); run(st, 20); },
  'ospf-cost': (st, b) => { run(st, 60); cmd(st, b('PC-A'), 'ping -c 3 10.0.9.10'); run(st, 20); },
  'ospf-reroute': (st, b) => { run(st, 60); down(st, b('R1'), 'eth2'); run(st, 60); cmd(st, b('PC-A'), 'ping -c 3 10.0.9.10'); run(st, 20); },
  'ospf-multiarea-note': (st, b) => { run(st, 40); cmd(st, b('PC-A'), 'ping -c 2 10.0.9.10'); run(st, 20); },
  // ---- BGP ----
  'bgp-ebgp': (st) => { run(st, 40); },
  'bgp-path': (st) => { run(st, 50); },
  'bgp-ibgp': (st) => { run(st, 50); },
  // ---- NAT ----
  'nat-pat': (st, b) => { const r = b('NAT-RTR'); r.nat = { ...r.nat, enabled: true, outsideIface: 'eth1', insideIfaces: ['eth0'] }; cmd(st, b('Inside-PC'), 'ping -c 3 203.0.113.9'); run(st, 20); },
  'nat-portforward': (st, b) => { const r = b('NAT-RTR'); r.nat.portForwards.push({ proto: 6, outsidePort: 8080, insideIp: ip('192.168.1.10'), insidePort: 7000 }); cmd(st, b('Inside-PC'), 'nc -l 7000'); cmd(st, b('Internet-Srv'), 'nc 203.0.113.1 8080 hello-from-outside'); run(st, 20); },
  // ---- Transport ----
  'udp-basics': (st, b) => { cmd(st, b('Server'), 'nc -l 9000 -u'); cmd(st, b('Client'), 'nc 10.0.0.2 9000 -u hi-over-udp'); run(st, 8); },
  'udp-unreachable': (st, b) => { cmd(st, b('Client'), 'nc 10.0.0.2 9999 -u knock'); run(st, 8); },
  'tcp-handshake': (st, b) => { cmd(st, b('Server'), 'nc -l 7000'); cmd(st, b('Client'), 'nc 10.0.0.2 7000 hello-tcp'); run(st, 8); },
  'tcp-teardown': (st, b) => { cmd(st, b('Server'), 'nc -l 7000'); cmd(st, b('Client'), 'nc 10.0.0.2 7000 bye'); run(st, 10); },
  'tcp-reliability': (st, b) => { cmd(st, b('Server'), 'iperf -s'); cmd(st, b('Client'), 'iperf -c 10.0.2.10 -n 400000'); run(st, 40); },
  'tcp-fastretx': (st, b) => { cmd(st, b('Server'), 'iperf -s'); cmd(st, b('Client'), 'iperf -c 10.0.2.10 -n 600000'); run(st, 0.2); const l = linkByEnds(st, 'R1', 'R2'); l.impair = { ...l.impair, dropNext: 1, dir: 'ab', filter: 'tcp.len > 0' }; run(st, 40); },
  'tcp-flowcontrol': (st, b) => { cmd(st, b('Server'), 'iperf -s -R 200'); cmd(st, b('Client'), 'iperf -c 10.0.0.2 -n 200000'); run(st, 12); },
  'tcp-congestion': (st, b) => { cmd(st, b('Server'), 'iperf -s'); cmd(st, b('Client'), 'iperf -c 10.0.2.10 -n 3000000'); run(st, 60); },
  'tcp-rto': (st, b) => { cmd(st, b('Server'), 'iperf -s'); cmd(st, b('Client'), 'iperf -c 10.0.2.10 -n 800000'); run(st, 0.1); const l = linkByEnds(st, 'R1', 'R2'); l.lossPct = 100; run(st, 3); l.lossPct = 0; run(st, 60); },
  // ---- DHCP & DNS ----
  'dhcp-dora': (st, b) => { const gw = b('Gateway'); gw.dhcpServer.enabled = true; ensureServices(st); cmd(st, b('Client'), 'dhclient'); run(st, 10); },
  'dns-recursive': (st, b) => { cmd(st, b('Client'), 'dig www.example.com'); run(st, 15); },
  'dns-caching': (st, b) => { cmd(st, b('Client'), 'dig example.com'); run(st, 15); },
  'dns-poison': (st, b) => { cmd(st, b('Client'), 'dig example.com'); run(st, 15); },
  // ---- HTTP ----
  'http-anatomy': (st, b) => { cmd(st, b('WebSrv'), 'httpd'); cmd(st, b('Client'), 'curl --no-recurse http://10.0.0.80/'); run(st, 10); cmd(st, b('Client'), 'curl --no-recurse http://10.0.0.80/missing'); run(st, 10); },
  'http-persistent': (st, b) => { cmd(st, b('WebSrv'), 'httpd'); cmd(st, b('Client'), 'curl http://10.0.0.80/'); run(st, 15); },
  'http-waterfall': (st, b) => { cmd(st, b('WebSrv'), 'httpd'); cmd(st, b('Client'), 'curl http://10.0.0.80/'); run(st, 15); },
  // ---- Wireless ----
  'wifi-assoc': (st, b) => { setWireless(b('Laptop'), 'eth0', { ssid: 'netsim-lab', channel: 6, range: 220 }); run(st, 2); cmd(st, b('Laptop'), 'ping -c 3 10.0.0.20'); run(st, 12); },
  'wifi-csmaca': (st, b) => { run(st, 2); cmd(st, b('STA-A'), 'ping -c 4 10.0.0.20'); cmd(st, b('STA-C'), 'ping -c 4 10.0.0.20'); run(st, 20); },
  'wifi-hidden': (st, b) => { run(st, 2); cmd(st, b('STA-A'), 'iperf -c 10.0.0.20 -u -b 20M -t 3'); cmd(st, b('STA-C'), 'iperf -c 10.0.0.20 -u -b 20M -t 3'); run(st, 8); },
  'wifi-rtscts': (st, b) => { run(st, 2); cmd(st, b('STA-A'), 'ping -c 3 10.0.0.20'); cmd(st, b('STA-C'), 'ping -c 3 10.0.0.20'); run(st, 25); },
  'wifi-range': (st) => { run(st, 3); },
  // ---- Security ----
  'sec-arpspoof': (st, b) => { cmd(st, b('Attacker'), 'arpspoof 10.0.0.1'); run(st, 4); },
  'sec-sniff-http': (st, b) => { cmd(st, b('WebSrv'), 'httpd'); cmd(st, b('Client'), 'curl -X POST --no-recurse http://10.0.0.80/login'); run(st, 10); },
  'sec-portscan': (st, b) => { cmd(st, b('Target'), 'httpd'); cmd(st, b('Attacker'), 'nc 10.0.0.10 80'); run(st, 6); cmd(st, b('Attacker'), 'nc 10.0.0.10 9999'); run(st, 6); },
  'sec-dhcp-exhaustion': (st, b) => { cmd(st, b('Client-1'), 'dhclient'); run(st, 10); cmd(st, b('Client-2'), 'dhclient'); run(st, 10); },
  'sec-recon-icmp': (st, b) => { cmd(st, b('Attacker'), 'ping -c 2 10.0.2.10'); run(st, 12); cmd(st, b('Attacker'), 'traceroute 10.0.2.10'); run(st, 30); },
  // ---- Capstones ----
  'cap-enterprise': (st, b) => { const gw = b('Gateway'); gw.dhcpServer.enabled = true; ensureServices(st); cmd(st, b('Server'), 'httpd'); cmd(st, b('Client'), 'dhclient'); run(st, 10); cmd(st, b('Client'), 'dig intranet.corp'); run(st, 12); cmd(st, b('Client'), 'curl http://intranet.corp/'); run(st, 12); },
  'cap-troubleshoot': (st, b) => { addStaticRoute(b('R2'), ip('10.0.1.0'), mask(24), ip('10.0.12.1')); cmd(st, b('PC-A'), 'ping -c 3 10.0.2.10'); run(st, 14); },
  'cap-secure': (st, b) => { cmd(st, b('Attacker'), 'arpspoof 10.0.0.1'); run(st, 4); cmd(st, b('Victim'), 'arp -s 10.0.0.1 02:00:00:03:00:00'); cmd(st, b('Attacker'), 'arpspoof 10.0.0.1'); run(st, 4); },
};

describe('every lab is completable (all checks pass after the intended solution)', () => {
  it('has a solver for all 70 labs', () => {
    const missing = ALL_LABS.filter(l => !SOLVERS[l.id]).map(l => l.id);
    expect(missing, 'labs missing a solver: ' + missing.join(', ')).toEqual([]);
    expect(ALL_LABS.length).toBe(70);
  });
  for (const lab of ALL_LABS) {
    it(`${lab.id} — ${lab.name}`, () => {
      const { st, byName } = mk(lab.id);
      SOLVERS[lab.id]!(st, byName);
      const failed = lab.checks.filter(c => !evalCheck(st, c)).map(c => `${c.id} (${c.kind})`);
      expect(failed, `${lab.id}: unmet checks -> ${failed.join('; ')}`).toEqual([]);
    });
  }
});
