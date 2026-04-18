// Decoded frame tree: what the inspector renders and the filter engine queries.
export type FieldValue = string | number | boolean;
export interface Field {
  key: string;         // filter key within the layer, e.g. "dst", "ttl"
  name: string;        // human label
  value: FieldValue;   // canonical value (numbers for numeric fields)
  display?: string;    // pretty form if different from value
  start: number;       // byte offset in the frame
  end: number;         // exclusive
  children?: Field[];  // e.g. flag bits
}
export interface Layer {
  proto: string;       // filter prefix: eth, vlan, arp, ipv4, icmp, udp, tcp, dns, http ...
  name: string;        // display name
  start: number;
  end: number;
  summary: string;
  fields: Field[];
  warnings: string[];
}
export interface DecodedFrame {
  length: number;
  layers: Layer[];
  proto: string;       // top-most protocol name for the list column
  src: string;         // best src address (ip if present else mac)
  dst: string;
  info: string;        // summary of top-most layer
  warnings: string[];
}
export function f(key: string, name: string, value: FieldValue, start: number, end: number, display?: string, children?: Field[]): Field {
  const x: Field = { key, name, value, start, end }; if (display !== undefined) x.display = display; if (children) x.children = children; return x;
}
