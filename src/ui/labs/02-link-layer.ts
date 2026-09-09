import { E, ip, m, scene, type Lab } from './helpers';
import type { ScenarioCheck } from '@/engine/types';
const MOD = 'Physical & Data Link';
const pingA = (dst: string): ScenarioCheck[] => [{ id: 'ping', label: `traffic reached ${dst}`, kind: 'terminalContains', node: 'PC-A', text: `bytes from ${dst}` }];

function lan(sniffer = true) {
  return (st: import('@/engine/types').EngineState) => {
    const a = E.addHost(st, 'laptop', 160, 300, 'PC-A'); const sw = E.addSwitch(st, 360, 200, 8, 'Switch1'); const b = E.addHost(st, 'desktop', 560, 300, 'PC-B');
    const l1 = E.connect(st, a.id, 0, sw.id, 0)!; E.connect(st, b.id, 0, sw.id, 1);
    E.setIfaceIp(st, a, 'eth0', ip('10.0.0.1'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('10.0.0.2'), m(24));
    if (sniffer) E.addSniffer(st, l1); return l1;
  };
}
export const LINK_LAYER: Lab[] = [
  { id: 'link-coding', module: MOD, name: 'Line coding: bits on the wire', difficulty: 'intro', minutes: 12,
    objectives: ['See how bits become an electrical/optical **signal**', 'Compare NRZ, NRZI, Manchester and 4B/5B', 'Understand why self-clocking codes exist'],
    theory: ['The physical layer turns **bits** into a **signal**. The simplest scheme, **NRZ** (non-return-to-zero), holds the line high for 1 and low for 0 — but a long run of identical bits has no transitions, so the receiver’s clock can drift.',
      '**NRZI** encodes a 1 as a *transition* and a 0 as *no transition*. **Manchester** (used by classic Ethernet) puts a transition in the middle of every bit, so it is **self-clocking**. **4B/5B** maps each 4-bit nibble to a 5-bit symbol chosen to guarantee transitions, then sends it (often over NRZI).',
      'The simulator can draw any captured frame’s first bytes as a waveform in each of these codes.'],
    build: () => scene('link-coding', 'Line coding: bits on the wire', 'Capture a frame and view it under four line codes.', pingA('10.0.0.2'), lan()),
    checks: pingA('10.0.0.2'),
    steps: [
      { title: 'Generate a frame', do: 'Ping PC-B once from PC-A and Turbo.', set: ['ping -c 1 10.0.0.2'], checkId: 'ping' },
      { title: 'Open the physical view', do: 'Click any captured frame, then expand **Physical layer (signal encoding)** under the hex dump.' },
      { title: 'Compare codes', do: 'Switch between NRZ, NRZI, Manchester and 4B/5B and watch the waveform for the same bits.', observe: 'Manchester always has a mid-bit transition; NRZ can sit flat for many bits.', note: 'For the byte you are viewing, which code produces the most transitions? Why does that help the receiver?' },
    ],
    questions: [{ q: 'Why is a self-clocking code valuable?', a: 'Guaranteed transitions let the receiver recover the sender’s clock from the signal itself, so both ends stay synchronised even over long runs of identical bits.' }],
    wrap: 'Every frame in every later lab starts life as one of these signals on the wire.' },

  { id: 'link-framing', module: MOD, name: 'Ethernet framing and the FCS', difficulty: 'intro', minutes: 12,
    objectives: ['Identify the fields of an Ethernet II frame', 'Understand the **FCS** (CRC-32) and how errors are detected', 'See the 64-byte minimum frame (padding)'],
    theory: ['An **Ethernet II** frame has a destination MAC, a source MAC, an EtherType (e.g. `0x0800` for IPv4, `0x0806` for ARP), the payload, and a 4-byte **Frame Check Sequence (FCS)** at the end.',
      'The FCS is a **CRC-32** over the whole frame. The receiver recomputes it; if it disagrees, the frame is corrupted and is silently dropped. Ethernet detects errors but does not correct them — that is left to higher layers.',
      'Frames also have a 64-byte minimum, so tiny payloads are padded.'],
    build: () => scene('link-framing', 'Ethernet framing and the FCS', 'Inspect the Ethernet header and FCS of a captured frame.', pingA('10.0.0.2'), lan()),
    checks: pingA('10.0.0.2'),
    steps: [
      { title: 'Capture', do: 'Ping PC-B once and Turbo.', set: ['ping -c 1 10.0.0.2'], checkId: 'ping' },
      { title: 'Read the Ethernet header', do: 'Click an ICMP frame and expand the **Ethernet II** layer.', observe: 'Destination and source MACs, the Type field, and the Frame check sequence marked [correct].', note: 'Record the source and destination MAC addresses and the EtherType.' },
      { title: 'See the minimum frame', do: 'Look at an ARP frame’s length.', observe: 'It is padded up to 64 bytes even though ARP is small.', note: 'Why enforce a minimum frame size? (Hint: it relates to collision detection on legacy Ethernet.)' },
    ],
    questions: [{ q: 'What does an FCS mismatch tell the receiver, and what does it do?', a: 'That the frame was corrupted in transit. Ethernet cannot fix it, so the receiver simply discards the frame; recovery (if any) is a higher layer’s job.' }],
    wrap: 'The FCS is the network’s first line of integrity defence — the next lab breaks it on purpose.' },

  { id: 'link-fcs', module: MOD, name: 'Corrupting a frame: FCS in action', difficulty: 'core', minutes: 14,
    objectives: ['Use a link impairment to corrupt frames', 'Observe the receiver dropping frames with a bad FCS', 'Connect physical errors to upper-layer loss'],
    theory: ['Real links introduce bit errors. We can simulate this: a link’s **manual impairments** include “corrupt next N frames”, which flips a byte so the FCS no longer matches.',
      'When PC-B receives a corrupted frame it fails the FCS check and drops it. From ICMP’s point of view the reply simply never arrives, so `ping` reports loss.'],
    build: () => scene('link-fcs', 'Corrupting a frame: FCS in action', 'Corrupt frames on the link and watch them fail the FCS and get dropped.', [...pingA('10.0.0.2'), { id: 'badfcs', label: 'A frame with a bad FCS was captured', kind: 'sniffHas', expr: 'eth.fcs_ok == false' }], lan()),
    checks: [...pingA('10.0.0.2'), { id: 'badfcs', label: 'A frame with a bad FCS was captured', kind: 'sniffHas', expr: 'eth.fcs_ok == false' }],
    steps: [
      { title: 'Baseline', do: 'Ping PC-B a few times and **Turbo** so a clean run works, and add PC-A to your notes as the source.', set: ['ping -c 2 10.0.0.2'], checkId: 'ping' },
      { title: 'Corrupt some frames', do: 'Double-click the PC-A–Switch link, and under **Manual impairments** set “Corrupt next N” and Apply.', set: ['Corrupt next N = 4', 'Direction = both'] },
      { title: 'Send again and observe', do: 'Ping PC-B again and Turbo. In the sniffer, find frames marked with a bad FCS (filter `eth.fcs_ok == false`).', set: ['ping -c 4 10.0.0.2', 'display filter: eth.fcs_ok == false'], observe: 'Corrupted frames appear; the receiver drops them.', note: 'How many pings were lost? Relate that to how many frames you corrupted.', checkId: 'badfcs' },
    ],
    questions: [{ q: 'Ethernet detected the error but the ping still failed. Whose job is recovery?', a: 'A higher layer’s. ICMP/ping does not retransmit. Reliable delivery is provided by TCP, not by Ethernet or IP.' }],
    wrap: 'You have traced a single flipped bit all the way up to application-visible packet loss.' },

  { id: 'link-domains', module: MOD, name: 'Broadcast domains', difficulty: 'core', minutes: 12,
    objectives: ['Understand what a broadcast domain is', 'See a broadcast frame reach every port of a switch'],
    theory: ['A **switch** floods **broadcast** frames (destination `ff:ff:ff:ff:ff:ff`) out every port except the one they arrived on. All ports of a switch therefore form one **broadcast domain**.',
      'ARP requests are broadcasts, so every host on the switch hears them. This is why unnecessary broadcasts hurt large flat networks — and why VLANs and routers exist to split broadcast domains (later modules).'],
    build: () => scene('link-domains', 'Broadcast domains', 'Watch an ARP broadcast reach every host on the switch.', [{ id: 'learn', label: 'The switch learned multiple MAC addresses', kind: 'macLearned', node: 'Switch1', count: 3 }], (st) => {
      const sw = E.addSwitch(st, 360, 120, 8, 'Switch1');
      const names = ['PC-A', 'PC-B', 'PC-C', 'PC-D'];
      names.forEach((nm, i) => { const h = E.addHost(st, i === 0 ? 'laptop' : 'desktop', 120 + i * 150, 320, nm); E.connect(st, h.id, 0, sw.id, i); E.setIfaceIp(st, h, 'eth0', ip(`10.0.0.${i + 1}`), m(24)); });
      E.addSniffer(st, 2); E.addSniffer(st, 3);
    }),
    checks: [{ id: 'learn', label: 'The switch learned multiple MAC addresses', kind: 'macLearned', node: 'Switch1', count: 3 }],
    steps: [
      { title: 'Ping into the domain', do: 'Open PC-A, ping PC-B and **Turbo**. The first packet triggers a broadcast ARP.', set: ['ping -c 1 10.0.0.2'] },
      { title: 'See the flood', do: 'Sniffers on PC-C’s and PC-D’s links show they also received the ARP request, even though it was not for them.', observe: 'A broadcast reaches every port.', note: 'Which hosts saw the ARP request? Which saw the ARP reply?' },
      { title: 'Check the MAC table', do: 'Open Switch1 → MAC tab after pinging a couple of hosts and Turbo.', set: ['ping -c 1 10.0.0.3'], observe: 'The switch learns each host’s port from the frames it sends.', checkId: 'learn' },
    ],
    questions: [{ q: 'Why can too many hosts in one broadcast domain be a problem?', a: 'Every broadcast (ARP, DHCP, etc.) is processed by every host. In a large flat network this wastes bandwidth and CPU, which is why we segment with VLANs and routers.' }],
    wrap: 'One switch = one broadcast domain. Later you will split it deliberately.' },
];
