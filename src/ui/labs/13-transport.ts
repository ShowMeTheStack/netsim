import { E, ip, m, scene, type Lab } from './helpers';
import type { EngineState, ScenarioCheck } from '@/engine/types';
const MOD = 'Transport (UDP/TCP)';
// A(10.0.1.10) - R1 - R2 - B(10.0.2.10). Middle link is the bottleneck/impairment point (sniffed).
function wan(opts: { bw?: number; edgeBw?: number; delay?: number; loss?: number; queue?: number; slowReader?: boolean } = {}) {
  return (st: EngineState) => {
    // The two edge links are fast; the middle link (bw) is the bottleneck, so its drop-tail queue
    // is the only place congestion builds. Edges must stay faster than bw or there is no bottleneck
    // and a lossless transfer never leaves slow start (cwnd would never meet a lowered ssthresh).
    const edgeBw = opts.edgeBw ?? 1e9;
    const a = E.addHost(st, 'laptop', 120, 320, 'Client'); const r1 = E.addHost(st, 'router', 320, 220, 'R1'); const r2 = E.addHost(st, 'router', 540, 220, 'R2'); const b = E.addHost(st, 'server', 740, 320, 'Server');
    const l1 = E.connect(st, a.id, 0, r1.id, 0, { delayUs: (opts.delay ?? 10000), bandwidthBps: edgeBw })!;
    const l2 = E.connect(st, r1.id, 1, r2.id, 0, { delayUs: (opts.delay ?? 10000), bandwidthBps: opts.bw ?? 20e6, lossPct: opts.loss ?? 0, queueDepth: opts.queue ?? 200 })!;
    E.connect(st, r2.id, 1, b.id, 0, { delayUs: (opts.delay ?? 10000), bandwidthBps: edgeBw });
    E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
    E.setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r1, 'eth1', ip('10.0.12.1'), m(24)); E.addStaticRoute(r1, ip('10.0.2.0'), m(24), ip('10.0.12.2'));
    E.setIfaceIp(st, r2, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, r2, 'eth1', ip('10.0.2.1'), m(24)); E.addStaticRoute(r2, ip('10.0.1.0'), m(24), ip('10.0.12.1'));
    E.setIfaceIp(st, b, 'eth0', ip('10.0.2.10'), m(24)); E.setDefaultGateway(b, ip('10.0.2.1'));
    E.addSniffer(st, l2); void l1;
  };
}
function lan() { return (st: EngineState) => { const a = E.addHost(st, 'laptop', 160, 300, 'Client'); const sw = E.addSwitch(st, 360, 180, 8, 'Switch1'); const b = E.addHost(st, 'server', 560, 300, 'Server'); const l1 = E.connect(st, a.id, 0, sw.id, 0)!; E.connect(st, b.id, 0, sw.id, 1); E.setIfaceIp(st, a, 'eth0', ip('10.0.0.1'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('10.0.0.2'), m(24)); E.addSniffer(st, l1); }; }

export const TRANSPORT_LABS: Lab[] = [
  { id: 'udp-basics', module: MOD, name: 'UDP: fire and forget', difficulty: 'intro', minutes: 12,
    objectives: ['Send a datagram with no connection setup', 'See UDP’s minimal header and lack of reliability'],
    theory: ['**UDP** is connectionless: no handshake, no acknowledgements, no retransmission. A datagram just carries source/destination ports, a length and a checksum, then your data. It is used where speed and simplicity beat reliability (DNS queries, streaming, games).'],
    build: () => scene('udp-basics', 'UDP: fire and forget', 'Send a UDP message with netcat and inspect the datagram.', [{ id: 'recv', label: 'The server received the UDP message', kind: 'terminalContains', node: 'Server', text: 'hi-over-udp' }, { id: 'udp', label: 'A UDP datagram was captured', kind: 'sniffHas', expr: 'udp' }], lan()),
    checks: [{ id: 'recv', label: 'The server received the UDP message', kind: 'terminalContains', node: 'Server', text: 'hi-over-udp' }, { id: 'udp', label: 'A UDP datagram was captured', kind: 'sniffHas', expr: 'udp' }],
    steps: [
      { title: 'Listen on the server', do: 'On **Server** start a UDP listener.', set: ['nc -l 9000 -u'] },
      { title: 'Send from the client', do: 'On **Client** send a UDP message and Turbo.', set: ['nc 10.0.0.2 9000 -u hi-over-udp'], observe: 'No handshake — the datagram just goes.', checkId: 'recv' },
      { title: 'Inspect', do: 'Click the UDP frame in the sniffer and expand the **User Datagram Protocol** layer.', observe: 'Just ports, length and checksum — far simpler than TCP.', note: 'How many bytes is the UDP header? What is missing compared to TCP?', checkId: 'udp' },
    ],
    questions: [{ q: 'Name one thing UDP does NOT do that TCP does, and a use case where that is fine.', a: 'UDP does not retransmit lost data (or order it). That is fine for live audio/video or DNS, where a late packet is useless and a lost one is better re-requested by the app.' }],
    wrap: 'UDP is the bare minimum on top of IP: ports plus a checksum. Everything else is the app’s problem.' },

  { id: 'udp-unreachable', module: MOD, name: 'Port unreachable', difficulty: 'core', minutes: 10,
    objectives: ['See what happens when no one is listening', 'Recognise ICMP port-unreachable'],
    theory: ['If a UDP datagram arrives for a port with no listener, the host replies with **ICMP port unreachable**. This is how a sender can learn a service is not running.'],
    build: () => scene('udp-unreachable', 'Port unreachable', 'Send to a closed UDP port and read the ICMP error.', [{ id: 'refused', label: 'The client learned the port was closed', kind: 'terminalMatches', node: 'Client', pattern: 'refused|unreachable' }], lan()),
    checks: [{ id: 'refused', label: 'The client learned the port was closed', kind: 'terminalMatches', node: 'Client', pattern: 'refused|unreachable' }],
    steps: [
      { title: 'Do NOT start a listener', do: 'Leave the server with nothing listening on port 9999.' },
      { title: 'Send anyway', do: 'From the client send a UDP datagram to the closed port and Turbo.', set: ['nc 10.0.0.2 9999 -u knock'], observe: 'The server returns ICMP port-unreachable; netcat reports the port refused.', checkId: 'refused', note: 'Which layer generated the error — UDP or ICMP?' },
      { title: 'Inspect the error', do: 'Find the ICMP frame in the sniffer.', observe: 'Type 3 (Destination unreachable), code 3 (Port unreachable), quoting the original datagram.' },
    ],
    questions: [{ q: 'A firewall often *drops* such packets instead of replying. What does the sender see then?', a: 'Nothing — no ICMP error comes back, so the sender just times out, unable to tell “closed” from “filtered”.' }],
    wrap: 'ICMP is IP’s feedback channel; port-unreachable is UDP’s way of saying “nobody home”.' },

  { id: 'tcp-handshake', module: MOD, name: 'The TCP three-way handshake', difficulty: 'core', minutes: 14,
    objectives: ['See SYN, SYN-ACK, ACK', 'Understand initial sequence numbers and options'],
    theory: ['TCP is **connection-oriented**. Before data flows, both ends synchronise with a **three-way handshake**: the client sends **SYN** (with an initial sequence number and options like MSS, window scale, SACK-permitted); the server replies **SYN-ACK**; the client finishes with **ACK**. Now both sides agree on sequence numbers and the connection is **ESTABLISHED**.'],
    build: () => scene('tcp-handshake', 'The TCP three-way handshake', 'Open a TCP connection and dissect the handshake.', [{ id: 'syn', label: 'A SYN was captured', kind: 'sniffHas', expr: 'tcp.flags.syn == 1 and tcp.flags.ack == 0' }, { id: 'synack', label: 'A SYN-ACK was captured', kind: 'sniffHas', expr: 'tcp.flags.syn == 1 and tcp.flags.ack == 1' }, { id: 'ok', label: 'The connection carried data', kind: 'terminalContains', node: 'Server', text: 'hello-tcp' }], lan()),
    checks: [{ id: 'syn', label: 'A SYN was captured', kind: 'sniffHas', expr: 'tcp.flags.syn == 1 and tcp.flags.ack == 0' }, { id: 'synack', label: 'A SYN-ACK was captured', kind: 'sniffHas', expr: 'tcp.flags.syn == 1 and tcp.flags.ack == 1' }, { id: 'ok', label: 'The connection carried data', kind: 'terminalContains', node: 'Server', text: 'hello-tcp' }],
    steps: [
      { title: 'Listen', do: 'On **Server** start a TCP listener.', set: ['nc -l 7000'] },
      { title: 'Connect and send', do: 'On **Client** open a TCP connection carrying a short message, and Turbo.', set: ['nc 10.0.0.2 7000 hello-tcp'], checkId: 'ok' },
      { title: 'Find the handshake', do: 'In the sniffer, filter `tcp` and read the first three segments.', set: ['display filter: tcp'], observe: 'SYN, then SYN-ACK, then ACK; the flags appear in the info column and the TCP layer.', note: 'Record the client ISN and server ISN, and the MSS advertised in the SYN.', checkId: 'synack' },
      { title: 'Read the options', do: 'Expand the SYN’s TCP layer → Options.', observe: 'MSS, window scale and SACK-permitted are negotiated at setup.', checkId: 'syn' },
    ],
    questions: [{ q: 'Why three messages and not two?', a: 'Each direction must synchronise its own sequence number and have it acknowledged. Two messages could sync only one direction; the third ACK confirms the server’s sequence number to complete both.' }],
    wrap: 'SYN → SYN-ACK → ACK: three packets that turn two strangers into a reliable byte pipe.' },

  { id: 'tcp-teardown', module: MOD, name: 'Teardown and TIME-WAIT', difficulty: 'core', minutes: 14,
    objectives: ['See the FIN exchange closing a connection', 'Understand the TIME-WAIT state'],
    theory: ['TCP closes gracefully with **FIN** segments: each side sends a FIN and gets an ACK, so both directions shut independently. The side that closes last enters **TIME-WAIT** (2×MSL) before fully releasing, to absorb any stray delayed segments and ensure the peer’s final ACK arrived.'],
    build: () => scene('tcp-teardown', 'Teardown and TIME-WAIT', 'Watch a connection close with FINs and land in TIME-WAIT.', [{ id: 'fin', label: 'A FIN was captured', kind: 'sniffHas', expr: 'tcp.flags.fin == 1' }, { id: 'data', label: 'Data was exchanged before closing', kind: 'terminalContains', node: 'Server', text: 'bye' }], lan()),
    checks: [{ id: 'fin', label: 'A FIN was captured', kind: 'sniffHas', expr: 'tcp.flags.fin == 1' }, { id: 'data', label: 'Data was exchanged before closing', kind: 'terminalContains', node: 'Server', text: 'bye' }],
    steps: [
      { title: 'Open and close a connection', do: 'On **Server** run `nc -l 7000`; on **Client** run the message send (netcat closes after sending), then Turbo.', set: ['nc -l 7000', 'nc 10.0.0.2 7000 bye'], checkId: 'data' },
      { title: 'Trace the teardown', do: 'In the sniffer, filter `tcp.flags.fin == 1` and read the FIN/ACK exchange.', set: ['display filter: tcp'], observe: 'Each side sends FIN and the peer ACKs it.', checkId: 'fin' },
      { title: 'Find TIME-WAIT', do: 'Open **Client → Sockets** right after closing (or view socket history).', observe: 'The connection sits in **TIME_WAIT** for 2×MSL, then disappears.', note: 'Why does the closing side linger in TIME-WAIT instead of vanishing immediately?' },
    ],
    questions: [{ q: 'What problem does TIME-WAIT prevent?', a: 'It ensures the final ACK reached the peer and lets any delayed duplicate segments from this connection expire, so they cannot be mistaken for data on a new connection reusing the same ports.' }],
    wrap: 'A clean close is four FIN/ACK steps plus a patient TIME-WAIT to tidy up.' },

  { id: 'tcp-reliability', module: MOD, name: 'Reliability: detecting and resending loss', difficulty: 'advanced', minutes: 16,
    objectives: ['Cause packet loss and watch TCP recover', 'Relate sequence/ack numbers to retransmission'],
    theory: ['TCP numbers every byte. The receiver ACKs the highest contiguous byte received. If the sender’s data is lost, no ACK advances, and after a timeout (or duplicate ACKs) TCP **retransmits**. This is how a lossy path still delivers every byte in order.'],
    build: () => scene('tcp-reliability', 'Reliability: detecting and resending loss', 'Drop segments on the path and watch TCP resend them.', [{ id: 'done', label: 'The transfer completed despite loss', kind: 'terminalMatches', node: 'Client', pattern: 'MBytes|KBytes' }, { id: 'retx', label: 'TCP retransmitted at least one segment', kind: 'tcpStat', node: 'Client', field: 'retx', min: 1 }], wan({ delay: 8000, bw: 20e6, loss: 4, queue: 40 })),
    checks: [{ id: 'done', label: 'The transfer completed despite loss', kind: 'terminalMatches', node: 'Client', pattern: 'MBytes|KBytes' }, { id: 'retx', label: 'TCP retransmitted at least one segment', kind: 'tcpStat', node: 'Client', field: 'retx', min: 1 }],
    steps: [
      { title: 'Note the lossy link', do: 'The R1–R2 link drops 4% of packets. Open **Client → Sockets** so you can watch the charts.' },
      { title: 'Transfer some data', do: 'On **Server** run `iperf -s`; on **Client** run a fixed-size transfer, then Turbo.', set: ['iperf -s', 'iperf -c 10.0.2.10 -n 400000'], checkId: 'done' },
      { title: 'Inspect retransmissions', do: 'In **Client → Sockets**, read the connection detail and the time-sequence chart.', observe: 'Red marks are retransmissions; the “retx” counter is non-zero.', note: 'How many retransmissions occurred? Did the transfer still deliver all the bytes?', checkId: 'retx' },
    ],
    questions: [{ q: 'How does the receiver signal which byte to resend from?', a: 'Its cumulative ACK names the next byte it expects. When that ACK stops advancing (or repeats), the sender knows the segment starting at that byte was lost and resends from there.' }],
    wrap: 'Sequence numbers + ACKs + retransmission = a reliable stream over an unreliable network.' },

  { id: 'tcp-fastretx', module: MOD, name: 'Fast retransmit and duplicate ACKs', difficulty: 'advanced', minutes: 16,
    objectives: ['Trigger three duplicate ACKs', 'See TCP resend without waiting for a timeout'],
    theory: ['Waiting for a timeout on every loss is slow. When a single segment is lost mid-stream, later segments still arrive and each triggers a **duplicate ACK** for the missing byte. After **three duplicate ACKs**, the sender performs a **fast retransmit** immediately, and (in Reno family) enters **fast recovery** — halving its window instead of collapsing it.'],
    build: () => scene('tcp-fastretx', 'Fast retransmit and duplicate ACKs', 'Drop one segment and watch three dup-ACKs trigger a fast retransmit.', [{ id: 'done', label: 'The transfer completed', kind: 'terminalMatches', node: 'Client', pattern: 'MBytes|KBytes' }, { id: 'fast', label: 'A fast retransmit occurred', kind: 'tcpStat', node: 'Client', field: 'fastRetx', min: 1 }], wan({ delay: 5000, bw: 50e6 })),
    checks: [{ id: 'done', label: 'The transfer completed', kind: 'terminalMatches', node: 'Client', pattern: 'MBytes|KBytes' }, { id: 'fast', label: 'A fast retransmit occurred', kind: 'tcpStat', node: 'Client', field: 'fastRetx', min: 1 }],
    steps: [
      { title: 'Start the transfer', do: 'On **Server** run `iperf -s`; on **Client** start a transfer and press **Play** so it is mid-flight.', set: ['iperf -s', 'iperf -c 10.0.2.10 -n 600000'] },
      { title: 'Drop one data segment', do: 'While it runs, double-click the R1–R2 link and under **Manual impairments** drop the next data segment: set filter `tcp.len > 0`, drop next 1, Apply.', set: ['filter: tcp.len > 0', 'drop next 1', 'direction: Client→Server'] },
      { title: 'Finish and inspect', do: 'Turbo to complete. Open **Client → Sockets**.', observe: 'The chart shows a cluster of dup-ACKs then an “FRX” marker; “fast retx” is ≥ 1 and RTOs stay 0.', checkId: 'fast', note: 'How many duplicate ACKs preceded the fast retransmit? Did the RTO timer ever fire?' },
      { title: 'Confirm completion', do: 'Read the iperf summary on the Client.', checkId: 'done' },
    ],
    questions: [{ q: 'Why is fast retransmit better than waiting for the RTO?', a: 'Three dup-ACKs are strong evidence of a single loss while data is still flowing. Resending at once avoids an idle RTO wait (often hundreds of ms), keeping throughput high.' }],
    wrap: 'Duplicate ACKs are TCP’s early-warning system; three of them mean “resend now, do not wait”.' },

  { id: 'tcp-flowcontrol', module: MOD, name: 'Flow control and the zero window', difficulty: 'advanced', minutes: 16,
    objectives: ['See the receive window throttle a fast sender', 'Watch a zero-window stall and probe'],
    theory: ['**Flow control** stops a fast sender from overwhelming a slow receiver. The receiver advertises a **receive window (rwnd)** — how many more bytes it can buffer. If its application reads slowly, the window shrinks; at **zero window** the sender must stop and send periodic **window probes** until space frees up.'],
    build: () => scene('tcp-flowcontrol', 'Flow control and the zero window', 'A slow reader forces the receiver window shut, throttling the sender.', [{ id: 'shrink', label: 'The advertised window shrank to near zero', kind: 'sniffHas', expr: 'tcp.window_size_value < 100' }, { id: 'data', label: 'The server was receiving (slowly)', kind: 'terminalContains', node: 'Server', text: 'SRV' }], (st) => { const a = E.addHost(st, 'laptop', 160, 300, 'Client'); const sw = E.addSwitch(st, 360, 180, 8, 'Switch1'); const b = E.addHost(st, 'server', 560, 300, 'Server'); const l1 = E.connect(st, a.id, 0, sw.id, 0, { delayUs: 20000 })!; E.connect(st, b.id, 0, sw.id, 1, { delayUs: 20000 }); E.setIfaceIp(st, a, 'eth0', ip('10.0.0.1'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('10.0.0.2'), m(24)); b.tcp.rcvBufCap = 8192; b.tcp.wscale = false; b.tcp.sack = false; E.addSniffer(st, l1); }),
    checks: [{ id: 'shrink', label: 'The advertised window shrank to near zero', kind: 'sniffHas', expr: 'tcp.window_size_value < 100' }, { id: 'data', label: 'The server was receiving (slowly)', kind: 'terminalContains', node: 'Server', text: 'SRV' }],
    steps: [
      { title: 'Start a slow-reading server', do: 'On **Server** start an iperf server that reads slowly (a small read rate models a slow app).', set: ['iperf -s -R 8000'] },
      { title: 'Send a lot, fast', do: 'On **Client** push a large transfer and press **Play** (this link has 20 ms latency, so watch it settle).', set: ['iperf -c 10.0.0.2 -n 200000'] },
      { title: 'Watch the window close', do: 'Open **Client → Sockets** and the cwnd/rwnd chart; filter the sniffer `tcp.window_size_value == 0`.', observe: 'The advertised window falls to 0; the sender pauses and sends periodic zero-window probes.', checkId: 'win0', note: 'What is the sender doing during the stall? How does it learn the window re-opened?' },
      { title: 'Confirm the stat', do: 'In the socket detail, the “zero-win probes” counter is non-zero.', checkId: 'zero' },
    ],
    questions: [{ q: 'How is flow control different from congestion control?', a: 'Flow control protects the *receiver* (its buffer, via rwnd). Congestion control protects the *network* (via cwnd, reacting to loss). The sender may send only up to the minimum of the two windows.' }],
    wrap: 'rwnd is the receiver’s handbrake; cwnd (next lab) is the network’s.' },

  { id: 'tcp-congestion', module: MOD, name: 'Congestion control: Tahoe, Reno, CUBIC', difficulty: 'advanced', minutes: 22,
    objectives: ['Understand slow start and congestion avoidance', 'Compare how Tahoe, Reno and CUBIC react to loss', 'Read the cwnd sawtooth'],
    theory: ['**Congestion control** finds a safe sending rate without a receiver bottleneck. It starts in **slow start** (cwnd doubles per RTT) until a threshold, then **congestion avoidance** (cwnd grows linearly). On loss: **Tahoe** drops cwnd to 1 and slow-starts again; **Reno** halves cwnd and does fast recovery (the classic sawtooth); **CUBIC** grows with a cubic curve for high-speed links. Same network, very different shapes.'],
    build: () => scene('tcp-congestion', 'Congestion control: Tahoe, Reno, CUBIC', 'Run the same transfer under different algorithms and compare cwnd.', [{ id: 'done', label: 'A transfer completed', kind: 'terminalMatches', node: 'Client', pattern: 'MBytes|KBytes' }], wan({ delay: 15000, bw: 20e6, queue: 15 })),
    checks: [{ id: 'done', label: 'A transfer completed', kind: 'terminalMatches', node: 'Client', pattern: 'MBytes|KBytes' }],
    steps: [
      { title: 'Pick Tahoe', do: 'Open **Client → Config → TCP** and set congestion control to **Tahoe** (or run `sysctl net.ipv4.tcp_congestion_control=tahoe`).', set: ['tcp_congestion_control = tahoe'] },
      { title: 'Transfer and watch cwnd', do: 'On **Server** run `iperf -s`; on **Client** run a large transfer; open **Client → Sockets** and watch the congestion-window chart while it runs (Play), then Turbo.', set: ['iperf -s', 'iperf -c 10.0.2.10 -n 3000000'], observe: 'On loss Tahoe collapses cwnd to 1 MSS and slow-starts again.', checkId: 'done', note: 'Sketch or describe Tahoe’s cwnd shape after a loss.' },
      { title: 'Switch to Reno', do: 'Press **Restart**, set congestion control to **Reno**, and repeat the transfer.', set: ['tcp_congestion_control = reno'], observe: 'Reno halves cwnd (fast recovery) instead of collapsing — the familiar sawtooth.', note: 'How does Reno’s recovery differ from Tahoe’s on the chart?' },
      { title: 'Switch to CUBIC', do: 'Restart again, set **CUBIC**, and repeat.', set: ['tcp_congestion_control = cubic'], observe: 'CUBIC probes back toward the previous maximum with a cubic curve.', note: 'Which algorithm recovered throughput fastest on this link? Why might CUBIC suit high-bandwidth links?' },
    ],
    questions: [
      { q: 'What is the difference between slow start and congestion avoidance?', a: 'Slow start grows cwnd exponentially (double per RTT) to quickly find capacity; once past ssthresh, congestion avoidance grows it linearly (about +1 MSS per RTT) to probe gently.' },
      { q: 'Why does Reno usually outperform Tahoe?', a: 'Reno halves cwnd and keeps sending (fast recovery) instead of resetting to 1 MSS, so it does not throw away the pipe it already filled after a single loss.' },
    ],
    wrap: 'The cwnd sawtooth is TCP constantly asking “how fast can I go?” and backing off when the network says “too fast”.' },

  { id: 'tcp-rto', module: MOD, name: 'RTO and exponential backoff', difficulty: 'advanced', minutes: 15,
    objectives: ['See the retransmission timeout fire when a whole window is lost', 'Understand exponential backoff of the RTO'],
    theory: ['When no ACKs arrive at all (e.g. a link goes down), fast retransmit cannot help — there are no dup-ACKs. TCP falls back on the **retransmission timeout (RTO)**, derived from measured RTT. Each successive timeout **doubles** the RTO (exponential backoff), and cwnd collapses to slow start. When the path recovers, the connection resumes.'],
    build: () => scene('tcp-rto', 'RTO and exponential backoff', 'Black out the link briefly and watch RTOs back off, then recover.', [{ id: 'rto', label: 'At least two RTOs fired (backoff)', kind: 'tcpStat', node: 'Client', field: 'rtoCount', min: 2 }, { id: 'done', label: 'The transfer completed after recovery', kind: 'terminalMatches', node: 'Client', pattern: 'MBytes|KBytes' }], wan({ delay: 5000, bw: 50e6 })),
    checks: [{ id: 'rto', label: 'At least two RTOs fired (backoff)', kind: 'tcpStat', node: 'Client', field: 'rtoCount', min: 2 }, { id: 'done', label: 'The transfer completed after recovery', kind: 'terminalMatches', node: 'Client', pattern: 'MBytes|KBytes' }],
    steps: [
      { title: 'Start a transfer', do: 'On **Server** run `iperf -s`; on **Client** start a transfer and press **Play**.', set: ['iperf -s', 'iperf -c 10.0.2.10 -n 800000'] },
      { title: 'Black out the link', do: 'Double-click the R1–R2 link and set **Random loss = 100%**, Apply. All segments now vanish.', set: ['loss = 100%'] },
      { title: 'Watch RTOs back off', do: 'Open **Client → Sockets**. With no ACKs, the RTO fires, doubles, fires again…', observe: 'The RTO value doubles each time; cwnd is at 1 MSS.', note: 'Record the RTO after the first, second and third timeout. What is the pattern?', checkId: 'rto' },
      { title: 'Heal and finish', do: 'Set the link loss back to **0%**, Apply, then Turbo.', set: ['loss = 0%'], observe: 'The next retransmit gets through and the transfer completes.', checkId: 'done' },
    ],
    questions: [{ q: 'Why does TCP back off the RTO exponentially instead of retrying at a fixed interval?', a: 'If the network is congested or down, retrying aggressively makes it worse. Doubling the wait reduces load during trouble and avoids synchronised retransmission storms, while still recovering quickly once the path returns.' }],
    wrap: 'The RTO is TCP’s last-resort timer; exponential backoff keeps a struggling network from being hammered.' },
];
