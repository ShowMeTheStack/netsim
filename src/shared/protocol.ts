// Messages between the UI thread and the engine worker.
import type { NodeState, LinkState, Breakpoint, BreakpointHit, Flight, CapturedFrame, Milestone, HostKind, NodeId, LinkId, SnifferId, LinkImpair, HostState, RfTransmission, WifiCapture } from '@/engine/types';
import type { CDiagnostic } from './cprograms';

export type RunMode = 'paused' | 'play' | 'turbo';
export interface SnifferMeta { id: SnifferId; linkId: LinkId; total: number; captureFilter: string }
export interface UiState {
  time: number; seq: number; seed: number; mode: RunMode; speed: number; queued: number; nextEventUs: number | null;
  nodes: Record<NodeId, NodeState>; links: Record<LinkId, LinkState>; sniffers: Record<SnifferId, SnifferMeta>;
  breakpoints: Breakpoint[]; lastHit: BreakpointHit | null; flights: Flight[]; log: { t: number; text: string }[];
  rf: { transmissions: RfTransmission[]; monitors: Record<number, { id: number; channel: number; total: number; frames: WifiCapture[] }> };
  scenario: { id?: string; title: string; description: string; results: { id: string; label: string; pass: boolean }[] } | null;
}
export type Cmd =
  | { type: 'addNode'; nodeType: 'host' | 'switch' | 'router' | 'ap'; kind?: HostKind; x: number; y: number; name?: string }
  | { type: 'removeNode'; id: NodeId } | { type: 'moveNode'; id: NodeId; x: number; y: number } | { type: 'renameNode'; id: NodeId; name: string }
  | { type: 'connect'; a: NodeId; aIface: number; b: NodeId; bIface: number } | { type: 'removeLink'; id: LinkId }
  | { type: 'setLink'; id: LinkId; props: Partial<Pick<LinkState, 'bandwidthBps' | 'bandwidthBpsRev' | 'delayUs' | 'jitterUs' | 'lossPct' | 'queueDepth' | 'mtu'>> }
  | { type: 'setImpair'; id: LinkId; impair: Partial<LinkImpair> }
  | { type: 'setHostTcp'; node: NodeId; tcp: Partial<HostState['tcp']> } | { type: 'setForwarding'; node: NodeId; on: boolean }
  | { type: 'addRoute'; node: NodeId; cidr: string; gw: string } | { type: 'delRoute'; node: NodeId; index: number }
  | { type: 'setDhcpServer'; node: NodeId; cfg: { enabled: boolean; iface: string; poolStart: string; poolEnd: string; prefix: number; gateway: string; dns: string } }
  | { type: 'setDnsConfig'; node: NodeId; recursion: boolean; roots: string; forwarders: string }
  | { type: 'setDnsZone'; node: NodeId; origin: string; text: string } | { type: 'delDnsZone'; node: NodeId; origin: string }
  | { type: 'setHttpDocroot'; node: NodeId; files: Record<string, string> }
  | { type: 'setHosts'; node: NodeId; text: string }
  | { type: 'setResolv'; node: NodeId; dns: string }
  | { type: 'setRip'; node: NodeId; enabled: boolean; networks: string }
  | { type: 'setOspf'; node: NodeId; enabled: boolean; networks: string; costs: Record<string, number> }
  | { type: 'setBgp'; node: NodeId; enabled: boolean; as: number; routerId: string; networks: string; routeReflector: boolean }
  | { type: 'addBgpNeighbor'; node: NodeId; peerIp: string; peerAs: number } | { type: 'delBgpNeighbor'; node: NodeId; peerIp: string }
  | { type: 'setNat'; node: NodeId; enabled: boolean; outsideIface: string; insideIfaces: string[] } | { type: 'addPortForward'; node: NodeId; proto: number; outsidePort: number; insideIp: string; insidePort: number } | { type: 'delPortForward'; node: NodeId; index: number }
  | { type: 'setSwitchVlan'; node: NodeId; enabled: boolean; ports: { mode: 'access' | 'trunk'; vlan: number; trunkVlans: number[] }[] }
  | { type: 'setSwitchScript'; node: NodeId; script: string | null }
  | { type: 'setWireless'; node: NodeId; iface: string; on: boolean; ssid: string; channel: number; range: number }
  | { type: 'setAp'; node: NodeId; ssid: string; channel: number; range: number; rtsCts: boolean }
  | { type: 'addAirMonitor'; channel: number } | { type: 'removeAirMonitor'; id: number }
  | { type: 'setIface'; node: NodeId; iface: string; ip: string | null; prefix: number; up?: boolean; mtu?: number }
  | { type: 'setGateway'; node: NodeId; gw: string | null }
  | { type: 'runCmd'; node: NodeId; line: string }
  | { type: 'addSniffer'; link: LinkId } | { type: 'removeSniffer'; id: SnifferId } | { type: 'clearCapture'; id: SnifferId } | { type: 'setCaptureFilter'; id: SnifferId; expr: string }
  | { type: 'addBreakpoint'; expr: string; milestones: Milestone[]; label?: string } | { type: 'removeBreakpoint'; id: number } | { type: 'toggleBreakpoint'; id: number; enabled: boolean }
  | { type: 'play' } | { type: 'pause' } | { type: 'turbo' } | { type: 'stepEvent' } | { type: 'stepPacket' } | { type: 'stepSyscall' } | { type: 'setSpeed'; speed: number } | { type: 'restart' }
  | { type: 'exportSession'; theme?: string } | { type: 'importSession'; json: string } | { type: 'newSession'; seed?: number }
  | { type: 'loadScenario'; json: string } | { type: 'requestState' }
  | { type: 'exportCapsule' } | { type: 'replayCapsule'; json: string }
  | { type: 'exportPcap'; snifferId: SnifferId; withLabels?: boolean; includeDropped?: boolean }
  | { type: 'compileRun'; node: NodeId; name: string; source: string; argv: string[]; backend: 'clang' | 'nsc' | 'stub' };
export type Msg =
  | { type: 'state'; st: UiState }
  | { type: 'capture'; snifferId: SnifferId; frames: CapturedFrame[]; reset?: boolean }
  | { type: 'session'; json: string }
  | { type: 'capsule'; json: string }
  | { type: 'capsuleResult'; ok: boolean; gotHash: string; wantHash: string }
  | { type: 'pcap'; snifferId: SnifferId; pcap: Uint8Array; labels?: string }
  | { type: 'imported'; theme?: string }
  | { type: 'error'; message: string }
  | { type: 'compile'; node: NodeId; ok: boolean; diagnostics: CDiagnostic[]; pid?: number }
  | { type: 'ready' };
