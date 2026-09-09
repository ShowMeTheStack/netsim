import { E, ip, m, scene, type Lab } from './helpers';
import type { ScenarioCheck } from '@/engine/types';
const MOD = 'Switching';
export const SWITCHING: Lab[] = [
  { id: 'sw-learning', module: MOD, name: 'MAC learning and forwarding', difficulty: 'intro', minutes: 12,
    objectives: ['Understand how a switch builds its MAC address table', 'Distinguish flooding (unknown) from forwarding (known)'],
    theory: ['A switch is **transparent**: hosts do not know it is there. It learns by watching the **source MAC** of every frame and recording which port it came in on. To forward, it looks up the **destination MAC**: if known, it sends out just that port; if unknown (or broadcast), it **floods** to all other ports.',
      'The first frame to a new host is always flooded because the switch has not learned it yet; the reply teaches the switch, so subsequent frames are forwarded directly.'],
    build: () => scene('sw-learning', 'MAC learning and forwarding', 'Ping across a switch and watch its MAC table fill in.', [{ id: 'ping', label: 'PC-A reached PC-B', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }, { id: 'learn', label: 'Switch learned both hosts', kind: 'macLearned', node: 'Switch1', count: 2 }], (st) => {
      const a = E.addHost(st, 'laptop', 140, 300, 'PC-A'); const sw = E.addSwitch(st, 360, 180, 8, 'Switch1'); const b = E.addHost(st, 'desktop', 580, 300, 'PC-B');
      const l1 = E.connect(st, a.id, 0, sw.id, 0)!; E.connect(st, b.id, 0, sw.id, 1);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.0.1'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('10.0.0.2'), m(24)); E.addSniffer(st, l1);
    }),
    checks: [{ id: 'ping', label: 'PC-A reached PC-B', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }, { id: 'learn', label: 'Switch learned both hosts', kind: 'macLearned', node: 'Switch1', count: 2 }],
    steps: [
      { title: 'Check the empty table', do: 'Open **Switch1 → MAC**. It starts empty.', note: 'Record that it is empty before any traffic.' },
      { title: 'Ping across', do: 'Ping PC-B from PC-A and Turbo.', set: ['ping -c 3 10.0.0.2'], checkId: 'ping' },
      { title: 'Watch it learn', do: 'Re-open Switch1 → MAC.', observe: 'Both PC-A and PC-B now map to ports.', note: 'Which was learned first, and why?', checkId: 'learn' },
      { title: 'See flood vs forward', do: 'Open Switch1 → Stats.', observe: 'The **flooded** counter is small (the first unknown frame) and **forwarded** grows for the rest.', note: 'How many frames were flooded vs forwarded?' },
    ],
    questions: [{ q: 'Why is the very first frame to a host flooded?', a: 'The switch has not yet seen that destination MAC as a source, so it does not know which port leads to it and must flood to find it.' }],
    wrap: 'Learning + flooding is the whole magic of a switch. Everything else is optimisation.' },

  { id: 'sw-aging', module: MOD, name: 'Aging and a changing topology', difficulty: 'core', minutes: 12,
    objectives: ['Understand MAC table aging', 'See what happens when a host moves ports'],
    theory: ['MAC table entries **age out** after a timeout if no frames refresh them, so the table adapts when hosts move or leave. If a host reappears on a different port, the next frame it sends updates its entry to the new port.'],
    build: () => scene('sw-aging', 'Aging and a changing topology', 'Observe learning, then reason about aging and moves.', [{ id: 'ping', label: 'PC-A reached PC-B', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }], (st) => {
      const a = E.addHost(st, 'laptop', 140, 300, 'PC-A'); const sw = E.addSwitch(st, 360, 180, 8, 'Switch1'); const b = E.addHost(st, 'desktop', 580, 300, 'PC-B');
      E.connect(st, a.id, 0, sw.id, 0); E.connect(st, b.id, 0, sw.id, 1);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.0.1'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('10.0.0.2'), m(24));
    }),
    checks: [{ id: 'ping', label: 'PC-A reached PC-B', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }],
    steps: [
      { title: 'Learn the table', do: 'Ping PC-B from PC-A and Turbo, then open Switch1 → MAC.', set: ['ping -c 2 10.0.0.2'], observe: 'Each entry shows an “ages out in” countdown.', checkId: 'ping' },
      { title: 'Watch it count down', do: 'Press Play (1×) and watch the countdown decrease, or note the aging value.', note: 'What is the default aging time? What would happen to an entry if the host went silent for that long?' },
      { title: 'Reason about a move', do: 'Predict: if PC-A were rewired to a different switch port, how would the table correct itself?', note: 'Write your prediction, then explain why the fix is automatic.' },
    ],
    questions: [{ q: 'Why do entries age out instead of living forever?', a: 'So the table reflects the current topology. If a host moves or is removed, stale entries would misdirect frames; aging lets the switch relearn.' }],
    wrap: 'Aging keeps the switch honest as the network changes underneath it.' },

  { id: 'sw-multi', module: MOD, name: 'Two switches, one network', difficulty: 'core', minutes: 12,
    objectives: ['Connect switches together', 'See MAC learning span multiple switches'],
    theory: ['Switches connect to each other with ordinary links. A frame for a host on the far switch is forwarded over the inter-switch link. Each switch independently learns which of *its* ports leads toward a given MAC (the far switch’s uplink port stands in for every host beyond it).'],
    build: () => scene('sw-multi', 'Two switches, one network', 'Ping between hosts on different switches.', [{ id: 'ping', label: 'PC-A reached PC-D across both switches', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.4' }], (st) => {
      const sw1 = E.addSwitch(st, 300, 160, 8, 'Switch1'); const sw2 = E.addSwitch(st, 560, 160, 8, 'Switch2');
      const trunk = E.connect(st, sw1.id, 7, sw2.id, 7)!;
      const a = E.addHost(st, 'laptop', 180, 320, 'PC-A'); const b = E.addHost(st, 'desktop', 320, 320, 'PC-B'); const c = E.addHost(st, 'desktop', 520, 320, 'PC-C'); const d = E.addHost(st, 'desktop', 660, 320, 'PC-D');
      E.connect(st, a.id, 0, sw1.id, 0); E.connect(st, b.id, 0, sw1.id, 1); E.connect(st, c.id, 0, sw2.id, 0); E.connect(st, d.id, 0, sw2.id, 1);
      [a, b, c, d].forEach((h, i) => E.setIfaceIp(st, h, 'eth0', ip(`10.0.0.${i + 1}`), m(24))); E.addSniffer(st, trunk);
    }),
    checks: [{ id: 'ping', label: 'PC-A reached PC-D across both switches', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.4' }],
    steps: [
      { title: 'Ping across the link', do: 'From PC-A (on Switch1) ping PC-D (on Switch2) and Turbo.', set: ['ping -c 3 10.0.0.4'], checkId: 'ping' },
      { title: 'Sniff the inter-switch link', do: 'A sniffer sits on the Switch1–Switch2 link.', observe: 'The cross-switch frames traverse it; local PC-A–PC-B traffic does not.', note: 'Ping PC-B from PC-A. Does that traffic appear on the inter-switch link? Why or why not?' },
    ],
    questions: [{ q: 'Does PC-A–PC-B traffic cross the inter-switch link?', a: 'No. Both are on Switch1, which forwards locally once it has learned them, so the frames never reach Switch2.' }],
    wrap: 'Switches compose transparently; the MAC table on each just points “toward” far hosts via the uplink.' },

  { id: 'sw-script', module: MOD, name: 'Program the switch yourself', difficulty: 'advanced', minutes: 16,
    objectives: ['Read the default learning algorithm as code', 'Replace it with a “hub” and a “black hole”', 'Appreciate why learning beats flooding'],
    theory: ['The switch’s learning logic is just code. You can replace it with your own JavaScript that runs in a sandbox with a small `api`: `api.src`, `api.dst`, `api.inPort`, `api.learn(mac, port)`, `api.lookup(mac)`, `api.forward(port)`, `api.flood()`, `api.drop()`, `api.log(msg)`.',
      'A **hub** always floods (`api.flood()`), wasting bandwidth. A **black hole** always drops. The default learn-and-forward is the sweet spot.'],
    build: () => scene('sw-script', 'Program the switch yourself', 'Edit the switch learning script and compare behaviours.', [{ id: 'ping', label: 'Connectivity still works with your script', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }], (st) => {
      const a = E.addHost(st, 'laptop', 160, 300, 'PC-A'); const sw = E.addSwitch(st, 360, 180, 8, 'Switch1'); const b = E.addHost(st, 'desktop', 560, 300, 'PC-B');
      E.connect(st, a.id, 0, sw.id, 0); E.connect(st, b.id, 0, sw.id, 1);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.0.1'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('10.0.0.2'), m(24));
    }),
    checks: [{ id: 'ping', label: 'Connectivity still works with your script', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }],
    steps: [
      { title: 'Read the default', do: 'Open **Switch1 → Script**, tick “Use custom learning script”. Read the default learn-and-forward code.', note: 'In one sentence, describe what the default script does per frame.' },
      { title: 'Make a hub', do: 'Replace the body with a single line and Save & apply, then ping and **Turbo**.', set: ['api.flood();', 'ping -c 2 10.0.0.2'], observe: 'It still works, but Switch1 → Stats shows everything flooded, nothing forwarded.', checkId: 'ping' },
      { title: 'Make a black hole', do: 'Change the script to always drop, then ping again and **Turbo**.', set: ['api.drop();', 'ping -c 2 10.0.0.2'], observe: 'No replies — the switch discards every frame.', note: 'Compare flooded/forwarded/filtered counters across the three scripts.' },
      { title: 'Restore', do: 'Click **Reset to default** (or untick the box) to return to normal learning.' },
    ],
    questions: [{ q: 'A hub “works” — why is learning still better?', a: 'Flooding sends every frame everywhere, wasting bandwidth and leaking traffic to hosts that should not see it. Learning confines unicast to the one port that needs it.' }],
    wrap: 'You have edited the forwarding brain of a switch and measured the cost of getting it wrong.' },
];
