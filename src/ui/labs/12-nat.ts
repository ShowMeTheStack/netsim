import { E, ip, m, scene, type Lab } from './helpers';
import type { ScenarioCheck } from '@/engine/types';
const MOD = 'NAT';
function natNet(portForward = false) { return (st: import('@/engine/types').EngineState) => {
  const a = E.addHost(st, 'laptop', 140, 320, 'Inside-PC'); const r = E.addHost(st, 'router', 360, 220, 'NAT-RTR'); const s = E.addHost(st, 'server', 600, 320, 'Internet-Srv');
  const lIn = E.connect(st, a.id, 0, r.id, 0, { delayUs: 1000 })!; const lOut = E.connect(st, r.id, 1, s.id, 0, { delayUs: 5000 })!;
  E.setIfaceIp(st, a, 'eth0', ip('192.168.1.10'), m(24)); E.setDefaultGateway(a, ip('192.168.1.1'));
  E.setIfaceIp(st, r, 'eth0', ip('192.168.1.1'), m(24)); E.setIfaceIp(st, r, 'eth1', ip('203.0.113.1'), m(24));
  E.setIfaceIp(st, s, 'eth0', ip('203.0.113.9'), m(24)); E.setDefaultGateway(s, ip('203.0.113.1'));
  E.addSniffer(st, lOut); void portForward; void lIn;
}; }
export const NAT_LABS: Lab[] = [
  { id: 'nat-pat', module: MOD, name: 'Hiding a LAN behind one address (PAT)', difficulty: 'core', minutes: 16,
    objectives: ['Configure source NAT / PAT on a router', 'See private addresses translated to one public address', 'Read the translation table'],
    theory: ['**NAT** (Network Address Translation) lets many private hosts share one public address. **PAT** (Port Address Translation, “NAT overload”) distinguishes flows by rewriting the **source port** as well, keeping a **translation table** to reverse replies. The outside world only ever sees the router’s public address.'],
    build: () => scene('nat-pat', 'Hiding a LAN behind one address (PAT)', 'Enable NAT and watch the inside address disappear on the outside.', [{ id: 'nat', label: 'NAT has an active translation', kind: 'natActive', node: 'NAT-RTR' }, { id: 'ping', label: 'Inside-PC reached the server via NAT', kind: 'terminalContains', node: 'Inside-PC', text: 'bytes from 203.0.113.9' }, { id: 'hidden', label: 'The outside link shows only the public source address', kind: 'sniffHas', expr: 'ipv4.src == 203.0.113.1' }], natNet()),
    checks: [{ id: 'nat', label: 'NAT has an active translation', kind: 'natActive', node: 'NAT-RTR' }, { id: 'ping', label: 'Inside-PC reached the server via NAT', kind: 'terminalContains', node: 'Inside-PC', text: 'bytes from 203.0.113.9' }, { id: 'hidden', label: 'The outside link shows only the public source address', kind: 'sniffHas', expr: 'ipv4.src == 203.0.113.1' }],
    steps: [
      { title: 'Enable NAT', do: 'Open **NAT-RTR → NAT**. Set the outside interface to eth1, tick eth0 as inside, then enable NAT.', set: ['Outside = eth1', 'Inside = eth0', 'NAT = enabled'] },
      { title: 'Send traffic out', do: 'From Inside-PC ping the Internet server and Turbo.', set: ['ping -c 3 203.0.113.9'], checkId: 'ping' },
      { title: 'Inspect the outside link', do: 'On the outside-link sniffer, click an echo request and read the IPv4 source.', observe: 'It is `203.0.113.1` (the router), not `192.168.1.10`.', note: 'Record the source address the server sees. How would a reply find its way back to the inside host?', checkId: 'hidden' },
      { title: 'Read the table', do: 'In NAT-RTR → NAT, view the translation table.', observe: 'Each flow maps inside IP:port ↔ outside port.', checkId: 'nat' },
    ],
    questions: [{ q: 'How does the router send a reply back to the correct inside host?', a: 'It looks up the reply’s destination port in its translation table, which records the original inside IP and port for that outside port, then rewrites the packet back to the inside host.' }],
    wrap: 'PAT is why a whole home or office can browse the Internet through a single public IP.' },

  { id: 'nat-portforward', module: MOD, name: 'Port forwarding to an inside server', difficulty: 'advanced', minutes: 16,
    objectives: ['Expose an inside service to the outside with a static port forward', 'Understand why inbound NAT needs an explicit rule'],
    theory: ['PAT only creates table entries for flows the *inside* starts, so unsolicited inbound connections have nowhere to go. A **static port forward** fixes this: “traffic to the public address on port X goes to inside host Y port Z”. This is how you publish a web or game server from behind NAT.'],
    build: () => scene('nat-portforward', 'Port forwarding to an inside server', 'Publish an inside listener to the outside via a port forward.', [{ id: 'nat', label: 'A port forward is configured', kind: 'count', node: 'NAT-RTR', path: 'nat.portForwards', min: 1 }, { id: 'recv', label: 'The inside listener received the outside connection', kind: 'terminalContains', node: 'Inside-PC', text: 'hello-from-outside' }], (st) => {
      const a = E.addHost(st, 'laptop', 140, 320, 'Inside-PC'); const r = E.addHost(st, 'router', 360, 220, 'NAT-RTR'); const s = E.addHost(st, 'server', 600, 320, 'Internet-Srv');
      E.connect(st, a.id, 0, r.id, 0, { delayUs: 1000 }); E.connect(st, r.id, 1, s.id, 0, { delayUs: 5000 });
      E.setIfaceIp(st, a, 'eth0', ip('192.168.1.10'), m(24)); E.setDefaultGateway(a, ip('192.168.1.1'));
      E.setIfaceIp(st, r, 'eth0', ip('192.168.1.1'), m(24)); E.setIfaceIp(st, r, 'eth1', ip('203.0.113.1'), m(24));
      E.setIfaceIp(st, s, 'eth0', ip('203.0.113.9'), m(24)); E.setDefaultGateway(s, ip('203.0.113.1'));
      r.nat = { enabled: true, outsideIface: 'eth1', insideIfaces: ['eth0'], table: [], portForwards: [], nextPort: 40000 };
    }),
    checks: [{ id: 'nat', label: 'A port forward is configured', kind: 'count', node: 'NAT-RTR', path: 'nat.portForwards', min: 1 }, { id: 'recv', label: 'The inside listener received the outside connection', kind: 'terminalContains', node: 'Inside-PC', text: 'hello-from-outside' }],
    steps: [
      { title: 'Start an inside listener', do: 'On **Inside-PC** open the terminal and start a TCP listener on port 7000.', set: ['nc -l 7000'] },
      { title: 'Try without a forward', do: 'From the Internet server, connect to the router’s public address on port 8080 and Turbo. It fails — no rule maps it inside.', set: ['nc 203.0.113.1 8080 hello-from-outside'], observe: 'Connection refused / no delivery.', note: 'Why does inbound fail when outbound NAT worked automatically?' },
      { title: 'Add a port forward', do: 'Open **NAT-RTR → NAT** and add a port forward: TCP outside 8080 → 192.168.1.10:7000.', set: ['TCP', 'outside port 8080', 'inside 192.168.1.10:7000'], checkId: 'nat' },
      { title: 'Retry', do: 'From the Internet server connect again and Turbo.', set: ['nc 203.0.113.1 8080 hello-from-outside'], observe: 'The inside listener prints the message.', checkId: 'recv' },
    ],
    questions: [{ q: 'Why is outbound NAT automatic but inbound needs a manual rule?', a: 'Outbound flows create table entries as they leave, so replies can be reversed. Inbound connections are unsolicited — there is no prior entry — so you must pre-declare the mapping with a port forward.' }],
    wrap: 'A port forward is the doorway you open in the NAT wall for a specific service.' },
];
