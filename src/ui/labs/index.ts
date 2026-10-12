// Aggregates every lab module into one catalog.
import type { Lab, LabModule } from './types';
import { GETTING_STARTED } from './01-getting-started';
import { LINK_LAYER } from './02-link-layer';
import { SWITCHING } from './03-switching';
import { ARP_LABS } from './04-arp';
import { VLAN_LABS } from './05-vlans';
import { IPV4_LABS } from './06-ipv4';
import { FRAG_ICMP } from './07-frag-icmp';
import { STATIC_ROUTING } from './08-static-routing';
import { RIP_LABS } from './09-rip';
import { OSPF_LABS } from './10-ospf';
import { BGP_LABS } from './11-bgp';
import { NAT_LABS } from './12-nat';
import { TRANSPORT_LABS } from './13-transport';
import { DHCP_DNS } from './14-dhcp-dns';
import { HTTP_LABS } from './15-http';
import { WIRELESS_LABS } from './16-wireless';
import { SECURITY_LABS } from './17-security';
import { CAPSTONE_LABS } from './18-capstones';
import { SOCKETS_C, SOCKETS_C_MODULE } from './19-sockets-c';

export const MODULES: LabModule[] = [
  { id: 'start', name: 'Getting Started', blurb: 'the workspace, packets, and the sniffer' },
  { id: 'link', name: 'Physical & Data Link', blurb: 'bits, frames, and the FCS' },
  { id: 'switch', name: 'Switching', blurb: 'MAC learning and forwarding' },
  { id: 'arp', name: 'ARP', blurb: 'mapping IP to MAC' },
  { id: 'vlan', name: 'VLANs', blurb: 'segmentation with 802.1Q' },
  { id: 'ipv4', name: 'IPv4 & Subnetting', blurb: 'addressing and forwarding decisions' },
  { id: 'frag', name: 'Fragmentation & ICMP', blurb: 'MTU, PMTUD, and control messages' },
  { id: 'static', name: 'Static Routing', blurb: 'hand-built forwarding paths' },
  { id: 'rip', name: 'RIP', blurb: 'distance-vector routing' },
  { id: 'ospf', name: 'OSPF', blurb: 'link-state routing' },
  { id: 'bgp', name: 'BGP', blurb: 'routing between autonomous systems' },
  { id: 'nat', name: 'NAT', blurb: 'address translation' },
  { id: 'transport', name: 'Transport (UDP/TCP)', blurb: 'reliability and congestion control' },
  { id: 'dhcpdns', name: 'DHCP & DNS', blurb: 'automatic config and name resolution' },
  { id: 'http', name: 'HTTP', blurb: 'the web on the wire' },
  { id: 'wireless', name: 'Wireless', blurb: '802.11, CSMA/CA, and the air' },
  { id: 'security', name: 'Security', blurb: 'attacks and defenses' },
  { id: 'capstone', name: 'Capstones', blurb: 'build and troubleshoot whole networks' },
  SOCKETS_C_MODULE,
];
export const ALL_LABS: Lab[] = [
  ...GETTING_STARTED, ...LINK_LAYER, ...SWITCHING, ...ARP_LABS, ...VLAN_LABS, ...IPV4_LABS, ...FRAG_ICMP,
  ...STATIC_ROUTING, ...RIP_LABS, ...OSPF_LABS, ...BGP_LABS, ...NAT_LABS, ...TRANSPORT_LABS, ...DHCP_DNS,
  ...HTTP_LABS, ...WIRELESS_LABS, ...SECURITY_LABS, ...CAPSTONE_LABS, ...SOCKETS_C,
];
