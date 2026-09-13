import { E, ip, m, scene, type Lab } from './helpers';
import type { EngineState, HostState, ScenarioCheck } from '@/engine/types';
import { SEC } from '@/engine/core';
const MOD = 'DHCP & DNS';
function dnsWorld() { return (st: EngineState) => {
  const sw = E.addSwitch(st, 400, 120, 16, 'LAN'); let port = 0;
  const add = (name: string, addr: string, kind: 'server' | 'laptop' = 'server') => { const n = E.addHost(st, kind, 120 + port * 150, 320, name); E.connect(st, n.id, 0, sw.id, port++); E.setIfaceIp(st, n, 'eth0', ip(addr), m(16)); return n; };
  const root = add('Root', '10.1.0.1'); const tld = add('TLD-com', '10.1.0.2'); const auth = add('NS-example', '10.1.0.3'); const resolver = add('Resolver', '10.1.0.4'); const client = add('Client', '10.1.0.5', 'laptop');
  root.dnsZones = [{ origin: '', text: '', records: [{ name: 'com', type: 2, ttl: 3600, data: { kind: 'ns', name: 'a.gtld.net' } }, { name: 'a.gtld.net', type: 1, ttl: 3600, data: { kind: 'a', ip: ip('10.1.0.2') } }] }];
  tld.dnsZones = [{ origin: 'com', text: '', records: [{ name: 'example.com', type: 2, ttl: 3600, data: { kind: 'ns', name: 'ns.example.com' } }, { name: 'ns.example.com', type: 1, ttl: 3600, data: { kind: 'a', ip: ip('10.1.0.3') } }] }];
  E.setDnsZone(auth, 'example.com', '$TTL 300\n@ IN SOA ns.example.com. admin.example.com. 1 7200 3600 604800 300\n@ IN NS ns.example.com.\nns IN A 10.1.0.3\n@ IN A 93.184.216.34\nwww IN CNAME example.com.\nmail IN A 93.184.216.35\n');
  resolver.dnsRecursion = true; resolver.dnsRoots = [ip('10.1.0.1')]; client.dns = ['10.1.0.4'];
  return { root, resolver, client };
}; }
export const DHCP_DNS: Lab[] = [
  { id: 'dhcp-dora', module: MOD, name: 'DHCP: the DORA handshake', difficulty: 'core', minutes: 15,
    objectives: ['Configure a DHCP server', 'Watch a client obtain an address (Discover, Offer, Request, Ack)', 'See gateway and DNS delivered automatically'],
    theory: ['**DHCP** hands out IP configuration automatically. A new client broadcasts a **DISCOVER**; a server replies with an **OFFER**; the client formally **REQUEST**s it; the server confirms with **ACK**. The lease also carries the subnet mask, default gateway and DNS servers — the whole config in four packets (“DORA”).'],
    build: () => scene('dhcp-dora', 'DHCP: the DORA handshake', 'Turn on a DHCP server and lease an address to a client.', [{ id: 'bound', label: 'The client got a DHCP lease', kind: 'terminalContains', node: 'Client', text: 'DHCPACK' }, { id: 'ip', label: 'The client received a pool address', kind: 'ifaceIp', node: 'Client', iface: 'eth0', ip: '10.0.0.100' }], (st) => {
      const gw = E.addHost(st, 'router', 200, 160, 'Gateway'); const sw = E.addSwitch(st, 400, 160, 8, 'Switch1'); const client = E.addHost(st, 'laptop', 400, 340, 'Client'); const srv = E.addHost(st, 'server', 620, 340, 'DNS-Srv');
      const l = E.connect(st, gw.id, 0, sw.id, 0)!; E.connect(st, client.id, 0, sw.id, 1); E.connect(st, srv.id, 0, sw.id, 2);
      E.setIfaceIp(st, gw, 'eth0', ip('10.0.0.1'), m(24)); E.setIfaceIp(st, srv, 'eth0', ip('10.0.0.53'), m(24));
      gw.dhcpServer = { enabled: false, iface: 'eth0', poolStart: ip('10.0.0.100'), poolEnd: ip('10.0.0.150'), mask: m(24), gateway: ip('10.0.0.1'), dns: [ip('10.0.0.53')], leaseUs: 3600 * SEC, leases: {} };
      E.addSniffer(st, l);
    }),
    checks: [{ id: 'bound', label: 'The client got a DHCP lease', kind: 'terminalContains', node: 'Client', text: 'DHCPACK' }, { id: 'ip', label: 'The client received a pool address', kind: 'ifaceIp', node: 'Client', iface: 'eth0', ip: '10.0.0.100' }],
    steps: [
      { title: 'Enable the server', do: 'Open **Gateway → Services → DHCP server**. The pool (10.0.0.100–150), gateway and DNS are pre-filled; tick **Enabled** and Apply.', set: ['Enabled = on'] },
      { title: 'Request a lease', do: 'On **Client** run the DHCP client and Turbo.', set: ['dhclient'], checkId: 'bound' },
      { title: 'Verify the config', do: 'Read the Client terminal and run `ip addr` and `route -n`.', set: ['ip addr', 'route -n'], observe: 'It received an address, mask, gateway and DNS — all from DHCP.', checkId: 'ip', note: 'Record the leased address, gateway and DNS server.' },
      { title: 'Trace DORA', do: 'In the sniffer, find the four DHCP messages.', observe: 'DISCOVER (broadcast) → OFFER → REQUEST → ACK.', note: 'Which of the four are broadcast and which are unicast?' },
    ],
    questions: [{ q: 'Why must the initial DISCOVER be a broadcast?', a: 'The client has no IP yet and does not know the server’s address, so it must broadcast to reach any DHCP server on the segment.' }],
    wrap: 'Four packets and the client is fully configured — no manual addressing needed.' },

  { id: 'dns-recursive', module: MOD, name: 'DNS: walking the hierarchy', difficulty: 'core', minutes: 16,
    objectives: ['Understand root, TLD and authoritative servers', 'See a recursive resolver do iterative queries', 'Follow a CNAME'],
    theory: ['DNS is a distributed tree. A **recursive resolver** answers a client by asking, in turn, a **root** server (“who runs .com?”), a **TLD** server (“who runs example.com?”), and finally the **authoritative** server (“what is www.example.com?”). It caches each answer. A **CNAME** is an alias that points one name at another, chased transparently.'],
    build: () => scene('dns-recursive', 'DNS: walking the hierarchy', 'Resolve www.example.com through root → TLD → authoritative.', [{ id: 'resolved', label: 'The client resolved the name to an address', kind: 'terminalContains', node: 'Client', text: '93.184.216.34' }, { id: 'noerror', label: 'The lookup returned NOERROR', kind: 'terminalContains', node: 'Client', text: 'status: NOERROR' }], dnsWorld()),
    checks: [{ id: 'resolved', label: 'The client resolved the name to an address', kind: 'terminalContains', node: 'Client', text: '93.184.216.34' }, { id: 'noerror', label: 'The lookup returned NOERROR', kind: 'terminalContains', node: 'Client', text: 'status: NOERROR' }],
    steps: [
      { title: 'Look up a name', do: 'On **Client** run `dig` for the web name and Turbo. The Client points at the Resolver (10.1.0.4).', set: ['dig www.example.com'], checkId: 'noerror' },
      { title: 'Read the answer', do: 'Read the ANSWER section.', observe: 'www.example.com is a CNAME for example.com, which is A `93.184.216.34`.', checkId: 'resolved', note: 'Write the CNAME chain and the final address.' },
      { title: 'See the resolver work', do: 'Open **Resolver → Services → DNS server**; note it is recursive and has a root hint. Check the event log for its iterative queries.', note: 'List the order the resolver contacted: root, then which server, then which?' },
      { title: 'Query other record types', do: 'Try an MX and an NS lookup, running **Turbo** after each.', set: ['dig MX example.com', 'dig NS example.com'], note: 'What does each record type tell you?' },
    ],
    questions: [{ q: 'What is the difference between a recursive resolver and an authoritative server?', a: 'A recursive resolver does the legwork of querying others on the client’s behalf and caches results. An authoritative server holds the actual records for a zone and answers only for that zone.' }],
    wrap: 'A single `dig` quietly walked the whole DNS tree from the root down to one answer.' },

  { id: 'dns-caching', module: MOD, name: 'DNS caching and TTL', difficulty: 'core', minutes: 12,
    objectives: ['See the resolver cache answers', 'Understand how TTL controls cache lifetime'],
    theory: ['Resolvers **cache** answers for the record’s **TTL** (time to live). A repeat query within the TTL is answered instantly from cache, without troubling the root or authoritative servers — which is what makes DNS fast and scalable.'],
    build: () => scene('dns-caching', 'DNS caching and TTL', 'Query twice and prove the second is served from cache.', [{ id: 'resolved', label: 'A name resolved successfully', kind: 'terminalContains', node: 'Client', text: '93.184.216.34' }], dnsWorld()),
    checks: [{ id: 'resolved', label: 'A name resolved successfully', kind: 'terminalContains', node: 'Client', text: '93.184.216.34' }],
    steps: [
      { title: 'First query (cold)', do: 'On **Client** run `dig example.com` and Turbo. Note the Query time.', set: ['dig example.com'], checkId: 'resolved', note: 'Record the first Query time (it includes the full hierarchy walk).' },
      { title: 'Check the Root traffic', do: 'Open **Root → Stats** and note its received-query count.' },
      { title: 'Second query (warm)', do: 'Run `dig example.com` again and Turbo.', set: ['dig example.com'], observe: 'Much faster — served from the resolver’s cache.', note: 'Did the Root’s query count increase the second time? Why not?' },
      { title: 'Reason about TTL', do: 'The record’s TTL controls how long the cache is valid.', note: 'If the TTL were 30 s, what would happen to a query 60 s later?' },
    ],
    questions: [{ q: 'Why does caching not consult the root the second time?', a: 'The resolver already holds a valid (unexpired) answer, so it returns it directly. Only after the TTL expires must it re-query the hierarchy.' }],
    wrap: 'Caching plus TTL is why the global DNS survives billions of lookups a second.' },

  { id: 'dns-poison', module: MOD, name: 'DNS cache poisoning (attack)', difficulty: 'advanced', minutes: 16,
    objectives: ['Understand why unauthenticated DNS is forgeable', 'Reason about transaction IDs and source ports as the only defence'],
    theory: ['Classic DNS answers are unauthenticated UDP. An attacker who can guess the query’s **transaction ID** and **source port** and answer *before* the real server can inject a forged record — **cache poisoning** — redirecting a name to an attacker IP. Randomising the ID and source port makes this hard; DNSSEC signs answers to make it impossible.'],
    build: () => scene('dns-poison', 'DNS cache poisoning (attack)', 'Explore why DNS is spoofable and what mitigates it.', [{ id: 'resolved', label: 'A legitimate lookup succeeded', kind: 'terminalContains', node: 'Client', text: '93.184.216.34' }], dnsWorld()),
    checks: [{ id: 'resolved', label: 'A legitimate lookup succeeded', kind: 'terminalContains', node: 'Client', text: '93.184.216.34' }],
    steps: [
      { title: 'Observe a normal lookup', do: 'On **Client** run `dig example.com` and Turbo, then sniff a DNS query in a monitor/link capture.', set: ['dig example.com'], checkId: 'resolved', note: 'Find the DNS **Transaction ID** in the query. How many bits is it?' },
      { title: 'Reason about the attack', do: 'An attacker on the path must forge a reply matching the transaction ID, source/destination ports and the question, before the real answer arrives.', note: 'How many bits of randomness must an off-path attacker guess (transaction ID + source port)? Why does that make blind spoofing hard?' },
      { title: 'Think about defences', do: 'List the mitigations you have seen.', note: 'Name two defences: one that makes guessing harder, one that authenticates answers cryptographically.' },
    ],
    questions: [{ q: 'Why does randomising the source port (not just the transaction ID) matter?', a: 'It adds ~16 more bits an off-path attacker must guess, multiplying the search space so that flooding forged replies in time becomes impractical. DNSSEC then removes the guessing game entirely by signing records.' }],
    wrap: 'DNS speed came from being simple and unauthenticated — which is exactly why randomisation and DNSSEC exist.' },
];
