import { E, ip, m, scene, type Lab } from './helpers';
import type { EngineState, HostState, ScenarioCheck } from '@/engine/types';
const MOD = 'Wireless';
function wlan(stationRange = 200) { return (st: EngineState) => {
  const sta = E.addHost(st, 'laptop', 200, 160, 'Laptop'); const ap = E.addAp(st, 200, 340, 'AP'); const srv = E.addHost(st, 'server', 440, 340, 'Server');
  E.connect(st, ap.id, 0, srv.id, 0, { delayUs: 200 }); ap.ssid = 'netsim-lab'; ap.range = 220;
  E.setIfaceIp(st, sta, 'eth0', ip('10.0.0.10'), m(24)); void stationRange; // radio starts OFF; the student enables it in the lab
  E.setIfaceIp(st, srv, 'eth0', ip('10.0.0.20'), m(24));
  return { sta, ap, srv };
}; }
function hidden(rtsCts: boolean) { return (st: EngineState) => {
  const ap = E.addAp(st, 380, 140, 'AP'); ap.range = 260; ap.rtsCts = rtsCts; ap.ssid = 'netsim-lab';
  const A = E.addHost(st, 'laptop', 180, 160, 'STA-A'); const C = E.addHost(st, 'laptop', 580, 160, 'STA-C'); const srv = E.addHost(st, 'server', 380, 340, 'Server');
  E.connect(st, ap.id, 0, srv.id, 0); E.setIfaceIp(st, srv, 'eth0', ip('10.0.0.20'), m(24));
  E.setWireless(A, 'eth0', { ssid: 'netsim-lab', channel: 6, range: 260 }); E.setWireless(C, 'eth0', { ssid: 'netsim-lab', channel: 6, range: 260 });
  E.setIfaceIp(st, A, 'eth0', ip('10.0.0.10'), m(24)); E.setIfaceIp(st, C, 'eth0', ip('10.0.0.11'), m(24));
}; }
export const WIRELESS_LABS: Lab[] = [
  { id: 'wifi-assoc', module: MOD, name: 'Associating with an access point', difficulty: 'core', minutes: 14,
    objectives: ['Turn a host into a Wi-Fi station', 'See beacons and the association by SSID', 'Reach a wired server over the air'],
    theory: ['An **access point (AP)** periodically broadcasts **beacons** advertising its **SSID**. A station in range with a matching SSID **associates** and can then send frames, which the AP **bridges** onto its wired LAN. The radio is a **shared medium**: only one device transmits at a time.'],
    build: () => scene('wifi-assoc', 'Associating with an access point', 'Join the SSID and ping a wired server.', [{ id: 'assoc', label: 'The laptop associated with the AP', kind: 'associated', node: 'Laptop' }, { id: 'ping', label: 'The laptop reached the server over Wi-Fi', kind: 'terminalContains', node: 'Laptop', text: 'bytes from 10.0.0.20' }], wlan()),
    checks: [{ id: 'assoc', label: 'The laptop associated with the AP', kind: 'associated', node: 'Laptop' }, { id: 'ping', label: 'The laptop reached the server over Wi-Fi', kind: 'terminalContains', node: 'Laptop', text: 'bytes from 10.0.0.20' }],
    steps: [
      { title: 'Add an air monitor', do: 'In the sniffer bar click **+ Air monitor** to capture the radio channel.' },
      { title: 'Configure the station', do: 'Open **Laptop → Config → Wireless**, tick the Wi-Fi station box, set the SSID, and Apply.', set: ['SSID = netsim-lab'] },
      { title: 'Associate', do: 'Press **Turbo**. The laptop hears a beacon and associates.', observe: 'A green association line appears; the AP’s range circle shows coverage.', checkId: 'assoc', note: 'How did the laptop discover which AP to join?' },
      { title: 'Ping over Wi-Fi', do: 'On the Laptop ping the server and Turbo.', set: ['ping -c 3 10.0.0.20'], observe: 'In the air monitor you will see beacons, DATA and ACK frames.', checkId: 'ping', note: 'Which frame types appear on the air? What does each ACK confirm?' },
    ],
    questions: [{ q: 'Why does every unicast Wi-Fi data frame get an ACK, unlike wired Ethernet?', a: 'The radio is lossy and half-duplex with no collision detection, so 802.11 confirms each unicast frame explicitly; a missing ACK triggers a retransmission.' }],
    wrap: 'Beacon → associate → bridge: how a laptop joins the wired world through the air.' },

  { id: 'wifi-csmaca', module: MOD, name: 'CSMA/CA: sharing the air', difficulty: 'advanced', minutes: 16,
    objectives: ['Understand carrier sense and random backoff', 'See two stations share one channel'],
    theory: ['Wi-Fi uses **CSMA/CA**: before transmitting, a station **senses** the channel; if busy it waits, then counts down a **random backoff** (contention window) to avoid two stations starting together. After a frame, the receiver waits **SIFS** then sends an ACK. This is *collision avoidance* — unlike wired Ethernet, radios cannot detect a collision while transmitting.'],
    build: () => scene('wifi-csmaca', 'CSMA/CA: sharing the air', 'Two stations on one AP take turns via CSMA/CA.', [{ id: 'a', label: 'STA-A reached the server', kind: 'terminalContains', node: 'STA-A', text: 'bytes from 10.0.0.20' }, { id: 'c', label: 'STA-C reached the server', kind: 'terminalContains', node: 'STA-C', text: 'bytes from 10.0.0.20' }], (st) => {
      const ap = E.addAp(st, 360, 140, 'AP'); ap.range = 260; ap.ssid = 'netsim-lab';
      const A = E.addHost(st, 'laptop', 240, 300, 'STA-A'); const C = E.addHost(st, 'laptop', 480, 300, 'STA-C'); const srv = E.addHost(st, 'server', 620, 140, 'Server');
      E.connect(st, ap.id, 0, srv.id, 0); E.setIfaceIp(st, srv, 'eth0', ip('10.0.0.20'), m(24));
      E.setWireless(A, 'eth0', { ssid: 'netsim-lab', channel: 6, range: 260 }); E.setWireless(C, 'eth0', { ssid: 'netsim-lab', channel: 6, range: 260 });
      E.setIfaceIp(st, A, 'eth0', ip('10.0.0.10'), m(24)); E.setIfaceIp(st, C, 'eth0', ip('10.0.0.11'), m(24));
    }),
    checks: [{ id: 'a', label: 'STA-A reached the server', kind: 'terminalContains', node: 'STA-A', text: 'bytes from 10.0.0.20' }, { id: 'c', label: 'STA-C reached the server', kind: 'terminalContains', node: 'STA-C', text: 'bytes from 10.0.0.20' }],
    steps: [
      { title: 'Add an air monitor', do: 'Click **+ Air monitor** to watch the shared channel.' },
      { title: 'Associate both stations', do: 'Turbo so both STA-A and STA-C associate (both SSIDs are preset).', observe: 'The AP lists two clients.' },
      { title: 'Send from both at once', do: 'On STA-A and STA-C, start pings, then Turbo.', set: ['STA-A: ping -c 4 10.0.0.20', 'STA-C: ping -c 4 10.0.0.20'], observe: 'In the air monitor the two stations’ frames interleave — they take turns, not overlap (they can hear each other here).', checkId: 'a', note: 'Both are in range of each other, so carrier sense mostly prevents collisions. What would happen if they could not hear each other? (next lab)', },
      { title: 'Confirm both worked', do: 'Both stations’ pings succeed.', checkId: 'c' },
    ],
    questions: [{ q: 'Why “collision avoidance” rather than “collision detection” like wired Ethernet?', a: 'A radio cannot listen while it transmits (its own signal swamps the receiver), so it cannot detect a collision in progress. It must avoid them up front with carrier sense and random backoff.' }],
    wrap: 'Sense, back off, transmit, ACK — the polite protocol that lets many radios share one channel.' },

  { id: 'wifi-hidden', module: MOD, name: 'The hidden-node problem', difficulty: 'advanced', minutes: 16,
    objectives: ['Create two stations that cannot hear each other', 'Observe collisions at the AP'],
    theory: ['Carrier sense only works if stations can hear each other. If **STA-A** and **STA-C** are both in range of the **AP** but *not each other* (“hidden”), neither senses the other, so they transmit simultaneously and their frames **collide at the AP**. This is the classic **hidden-node problem**.'],
    build: () => scene('wifi-hidden', 'The hidden-node problem', 'Two hidden stations collide at the AP under load.', [{ id: 'collide', label: 'Collisions or retries occurred at the AP', kind: 'count', node: 'AP', path: 'counters.collisions', min: 1 }], hidden(false)),
    checks: [{ id: 'collide', label: 'Collisions or retries occurred at the AP', kind: 'count', node: 'AP', path: 'counters.collisions', min: 1 }],
    steps: [
      { title: 'See the geometry', do: 'STA-A and STA-C sit on opposite sides of the AP, each in the AP’s range but beyond each other’s. Add an air monitor.', note: 'Measure (roughly) the distance A–C vs each station’s range. Can they hear each other?' },
      { title: 'Associate both', do: 'Turbo so both associate to “netsim-lab”.' },
      { title: 'Load the channel', do: 'From both STA-A and STA-C run heavy UDP transfers to the server, then Turbo.', set: ['STA-A: iperf -c 10.0.0.20 -u -b 20M -t 3', 'STA-C: iperf -c 10.0.0.20 -u -b 20M -t 3'], observe: 'The AP records collisions/retries; the air monitor highlights collided frames.', checkId: 'collide', note: 'Open AP → Wireless and record the collisions and retries counters.' },
    ],
    questions: [{ q: 'Why does carrier sense fail to prevent these collisions?', a: 'Each hidden station senses the channel as idle because it cannot hear the other’s transmission, so both send at once and collide at the AP, which *can* hear both.' }],
    wrap: 'Carrier sense is only as good as what a station can hear — hidden nodes break that assumption.' },

  { id: 'wifi-rtscts', module: MOD, name: 'RTS/CTS to the rescue', difficulty: 'advanced', minutes: 16,
    objectives: ['Enable RTS/CTS', 'Understand the NAV and how it silences hidden nodes'],
    theory: ['**RTS/CTS** solves hidden nodes with a reservation handshake. A station sends a short **Request To Send**; the AP replies **Clear To Send**, which *every* station in the AP’s range hears — including the hidden one. On hearing the CTS they set a **NAV** (network allocation vector) timer and stay quiet for the reserved duration, so the data frame goes through uncollided.'],
    build: () => scene('wifi-rtscts', 'RTS/CTS to the rescue', 'Enable RTS/CTS and let both hidden stations succeed.', [{ id: 'a', label: 'STA-A completed its transfer', kind: 'terminalMatches', node: 'STA-A', pattern: 'received|MBytes|KBytes' }, { id: 'c', label: 'STA-C completed its transfer', kind: 'terminalMatches', node: 'STA-C', pattern: 'received|MBytes|KBytes' }], hidden(true)),
    checks: [{ id: 'a', label: 'STA-A completed its transfer', kind: 'terminalMatches', node: 'STA-A', pattern: 'received|MBytes|KBytes' }, { id: 'c', label: 'STA-C completed its transfer', kind: 'terminalMatches', node: 'STA-C', pattern: 'received|MBytes|KBytes' }],
    steps: [
      { title: 'Confirm RTS/CTS is on', do: 'Open **AP → Wireless**. RTS/CTS is enabled for this lab.', note: 'What does the AP send that both hidden stations can hear?' },
      { title: 'Associate and load', do: 'Turbo to associate, then run pings from both STA-A and STA-C and Turbo.', set: ['STA-A: ping -c 3 10.0.0.20', 'STA-C: ping -c 3 10.0.0.20'], observe: 'The air monitor shows RTS and CTS control frames before data; both stations complete their pings.', checkId: 'a' },
      { title: 'Confirm both', do: 'Both stations reach the server despite being hidden.', checkId: 'c', note: 'How does the CTS silence the hidden station even though it never heard the RTS?' },
    ],
    questions: [{ q: 'Why does the CTS (not the RTS) solve the hidden-node problem?', a: 'The RTS is only heard by stations near the sender; the CTS comes from the AP, which every station in the cell can hear, so even the hidden station learns to defer via its NAV.' }],
    wrap: 'A tiny two-frame reservation buys collision-free delivery when carrier sense alone cannot.' },

  { id: 'wifi-range', module: MOD, name: 'Range and coverage', difficulty: 'core', minutes: 12,
    objectives: ['See that association requires being in range', 'Reason about coverage and roaming'],
    theory: ['A station can only associate with an AP whose signal reaches it. Move a station out of the AP’s range circle and it never hears a beacon, so it cannot join. Real deployments use overlapping APs so a moving client can **roam** from one to the next.'],
    build: () => scene('wifi-range', 'Range and coverage', 'Place a station out of range and confirm it cannot associate.', [{ id: 'nearassoc', label: 'The in-range station (Near) associated', kind: 'associated', node: 'Near' }], (st) => {
      const ap = E.addAp(st, 200, 300, 'AP'); ap.range = 150; ap.ssid = 'netsim-lab';
      const near = E.addHost(st, 'laptop', 260, 180, 'Near'); const far = E.addHost(st, 'laptop', 700, 180, 'Far'); const srv = E.addHost(st, 'server', 200, 460, 'Server');
      E.connect(st, ap.id, 0, srv.id, 0); E.setIfaceIp(st, srv, 'eth0', ip('10.0.0.20'), m(24));
      E.setWireless(near, 'eth0', { ssid: 'netsim-lab', channel: 6, range: 150 }); E.setWireless(far, 'eth0', { ssid: 'netsim-lab', channel: 6, range: 150 });
      E.setIfaceIp(st, near, 'eth0', ip('10.0.0.10'), m(24)); E.setIfaceIp(st, far, 'eth0', ip('10.0.0.11'), m(24));
    }),
    checks: [{ id: 'nearassoc', label: 'The in-range station (Near) associated', kind: 'associated', node: 'Near' }],
    steps: [
      { title: 'See the range', do: 'The AP’s dashed circle shows coverage (range 150). “Near” is inside; “Far” is well outside.', note: 'Which station is inside the range circle?' },
      { title: 'Try to associate both', do: 'Turbo.', observe: 'Only “Near” associates; “Far” keeps scanning — it never hears a beacon.', note: 'Open AP → Wireless: how many clients associated?' },
      { title: 'Confirm reachability', do: 'From “Near” ping the server and **Turbo** (works); from “Far” ping it (fails — not associated).', set: ['Near: ping -c 2 10.0.0.20', 'Far: ping -c 1 10.0.0.20'], checkId: 'nearassoc' },
      { title: 'Fix it', do: 'Drag “Far” into the range circle (Select tool), Turbo again, and re-ping.', note: 'What would you add to cover a large building without gaps?' },
    ],
    questions: [{ q: 'What is roaming, and what makes it possible?', a: 'Roaming is a client moving its association from one AP to another as it travels. Overlapping coverage from multiple APs (usually same SSID) lets the client re-associate before it loses signal.' }],
    wrap: 'No signal, no association — coverage planning is half of real Wi-Fi engineering.' },
];
