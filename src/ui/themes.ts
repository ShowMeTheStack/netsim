// 40 themes: 20 dark + 20 light. Every color the UI uses is a CSS variable set here, so a theme
// switch is instant. Protocol colors are part of each theme so the sniffer stays legible in both modes.
export interface Theme { id: string; name: string; dark: boolean; vars: Record<string, string> }

interface Seed { id: string; name: string; bg: string; bg2: string; bg3: string; border: string; fg: string; fg2: string; accent: string; canvas: string; grid: string }
function darkProtos(): Record<string, string> {
  return { '--proto-eth': '#3b4048', '--proto-arp': '#5a4d1f', '--proto-rarp': '#5a4d1f', '--proto-ipv4': '#1f3d5a', '--proto-icmp': '#4a2a5a', '--proto-tcp': '#1f4a3a', '--proto-udp': '#3a4a1f', '--proto-dns': '#1f4a4a', '--proto-http': '#4a1f2a', '--proto-vlan': '#4a3a1f', '--proto-data': '#333', '--proto-drop': '#5a1f1f', '--proto-dhcp': '#2a3a5a', '--proto-rip': '#3a2a4a', '--proto-ospf': '#2a4a3a', '--proto-bgp': '#4a3a2a' };
}
function lightProtos(): Record<string, string> {
  return { '--proto-eth': '#e2e6ea', '--proto-arp': '#fff3c4', '--proto-rarp': '#fff3c4', '--proto-ipv4': '#dbeafe', '--proto-icmp': '#f3e0ff', '--proto-tcp': '#d7f5e6', '--proto-udp': '#e9f5d7', '--proto-dns': '#d7f2f5', '--proto-http': '#ffe0e6', '--proto-vlan': '#f5ead7', '--proto-data': '#eee', '--proto-drop': '#ffd7d7', '--proto-dhcp': '#dbe4fe', '--proto-rip': '#ece0fe', '--proto-ospf': '#d7f5ea', '--proto-bgp': '#fdeed7' };
}
function build(s: Seed, dark: boolean): Theme {
  const vars: Record<string, string> = {
    '--bg': s.bg, '--bg2': s.bg2, '--bg3': s.bg3, '--border': s.border, '--fg': s.fg, '--fg2': s.fg2,
    '--accent': s.accent, '--accent-fg': dark ? '#ffffff' : '#ffffff', '--danger': dark ? '#e5484d' : '#dc2626', '--ok': dark ? '#30a46c' : '#16a34a', '--warn': dark ? '#f5a524' : '#d97706',
    '--canvas': s.canvas, '--grid': s.grid, '--link': dark ? '#5b6573' : '#8a94a1', '--node': s.bg2, '--node-border': s.border, '--select': s.accent,
    '--font': "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", '--mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    ...(dark ? darkProtos() : lightProtos()),
  };
  return { id: s.id, name: s.name, dark, vars };
}
const DARK_SEEDS: Seed[] = [
  { id: 'midnight', name: 'Midnight', bg: '#0f1216', bg2: '#161a20', bg3: '#1e232b', border: '#2a3038', fg: '#e6e9ee', fg2: '#9aa3ad', accent: '#4f8cff', canvas: '#0b0e12', grid: '#161b22' },
  { id: 'graphite', name: 'Graphite', bg: '#141414', bg2: '#1c1c1c', bg3: '#262626', border: '#333333', fg: '#eaeaea', fg2: '#9a9a9a', accent: '#9ccc65', canvas: '#101010', grid: '#1a1a1a' },
  { id: 'ocean', name: 'Deep Ocean', bg: '#07131f', bg2: '#0c1b2a', bg3: '#122538', border: '#1d3550', fg: '#dbeafe', fg2: '#7f9cc0', accent: '#38bdf8', canvas: '#050e17', grid: '#0c1926' },
  { id: 'forest', name: 'Forest', bg: '#0d1510', bg2: '#131e17', bg3: '#1b2a20', border: '#28402f', fg: '#e3f0e6', fg2: '#8fae97', accent: '#4ade80', canvas: '#0a110d', grid: '#131d16' },
  { id: 'plum', name: 'Plum', bg: '#160f1c', bg2: '#1f1528', bg3: '#2a1d36', border: '#3d2b4d', fg: '#f0e6f7', fg2: '#b298c4', accent: '#c084fc', canvas: '#110b16', grid: '#1c1424' },
  { id: 'ember', name: 'Ember', bg: '#1a0f0a', bg2: '#241611', bg3: '#33201a', border: '#4d3226', fg: '#f7e9e3', fg2: '#c4a091', accent: '#fb923c', canvas: '#150c07', grid: '#221410' },
  { id: 'slate', name: 'Slate', bg: '#0f1419', bg2: '#171d24', bg3: '#212a33', border: '#313d49', fg: '#e2e8ef', fg2: '#8b97a5', accent: '#60a5fa', canvas: '#0b0f14', grid: '#151b21' },
  { id: 'crimson', name: 'Crimson', bg: '#170d10', bg2: '#211318', bg3: '#301b22', border: '#4a2934', fg: '#f7e3e9', fg2: '#c491a1', accent: '#f43f5e', canvas: '#12090c', grid: '#1e1116' },
  { id: 'teal-night', name: 'Teal Night', bg: '#08161a', bg2: '#0d2026', bg3: '#122d35', border: '#1d454f', fg: '#d6f0f5', fg2: '#7fb0ba', accent: '#2dd4bf', canvas: '#061114', grid: '#0c1c21' },
  { id: 'amber-dark', name: 'Amber Dark', bg: '#17140a', bg2: '#211d0f', bg3: '#302a17', border: '#4a4126', fg: '#f5efd9', fg2: '#c4b98f', accent: '#facc15', canvas: '#131007', grid: '#1e1a0f' },
  { id: 'indigo', name: 'Indigo', bg: '#0e0f1c', bg2: '#161829', bg3: '#1f2138', border: '#2f3352', fg: '#e6e8f7', fg2: '#9599c4', accent: '#818cf8', canvas: '#0a0b16', grid: '#141625' },
  { id: 'rose-dark', name: 'Rose Dark', bg: '#1a0f14', bg2: '#25161d', bg3: '#341f29', border: '#4d2d3b', fg: '#f7e3ec', fg2: '#c491a6', accent: '#fb7185', canvas: '#15090f', grid: '#1f131a' },
  { id: 'mono-dark', name: 'Mono Dark', bg: '#101010', bg2: '#181818', bg3: '#222222', border: '#303030', fg: '#e0e0e0', fg2: '#909090', accent: '#e0e0e0', canvas: '#0c0c0c', grid: '#161616' },
  { id: 'cyber', name: 'Cyber', bg: '#0a0e14', bg2: '#0f1620', bg3: '#16202e', border: '#1f3348', fg: '#c8f5ff', fg2: '#6fb0c4', accent: '#22d3ee', canvas: '#070a0f', grid: '#0d141d' },
  { id: 'lime-dark', name: 'Lime Dark', bg: '#121509', bg2: '#1a1f0e', bg3: '#252c16', border: '#394525', fg: '#eef5d9', fg2: '#aeb98f', accent: '#a3e635', canvas: '#0e1007', grid: '#171b0e' },
  { id: 'sky-dark', name: 'Sky Dark', bg: '#0b1220', bg2: '#111a2c', bg3: '#18253c', border: '#243756', fg: '#dbe9fe', fg2: '#8ba3c4', accent: '#0ea5e9', canvas: '#080d18', grid: '#101827' },
  { id: 'sand-dark', name: 'Sand Dark', bg: '#16130f', bg2: '#201c16', bg3: '#2e281f', border: '#463d30', fg: '#f0e9dd', fg2: '#c0b299', accent: '#d6a35c', canvas: '#120f0b', grid: '#1d1811' },
  { id: 'violet-steel', name: 'Violet Steel', bg: '#12111a', bg2: '#1a1926', bg3: '#242338', border: '#363454', fg: '#e8e6f2', fg2: '#9d9ac0', accent: '#a78bfa', canvas: '#0e0d14', grid: '#181725' },
  { id: 'coal', name: 'Coal', bg: '#0c0d0e', bg2: '#141516', bg3: '#1d1f21', border: '#2b2e31', fg: '#dfe3e6', fg2: '#8d949a', accent: '#94a3b8', canvas: '#090a0b', grid: '#131415' },
  { id: 'aurora', name: 'Aurora', bg: '#0a1418', bg2: '#0f2028', bg3: '#152d38', border: '#204552', fg: '#d9f5ee', fg2: '#82b3ab', accent: '#34d399', canvas: '#071013', grid: '#0c1a20' },
];
const LIGHT_SEEDS: Seed[] = [
  { id: 'daylight', name: 'Daylight', bg: '#f6f7f9', bg2: '#ffffff', bg3: '#eef0f3', border: '#d7dbe0', fg: '#1b1f24', fg2: '#5b6470', accent: '#2563eb', canvas: '#fbfbfc', grid: '#e9ecf0' },
  { id: 'paper', name: 'Paper', bg: '#f4f1ea', bg2: '#fffdf8', bg3: '#ece7dc', border: '#d9d2c3', fg: '#2b2620', fg2: '#7a7060', accent: '#b45309', canvas: '#fbf9f4', grid: '#ebe6da' },
  { id: 'mint', name: 'Mint', bg: '#eef7f2', bg2: '#ffffff', bg3: '#e0efe6', border: '#c6dccf', fg: '#12241a', fg2: '#4e7060', accent: '#0f9d58', canvas: '#f7fcf9', grid: '#e3efe8' },
  { id: 'sky', name: 'Sky', bg: '#eef4fb', bg2: '#ffffff', bg3: '#e0ebf6', border: '#c5d8ec', fg: '#132030', fg2: '#4c6484', accent: '#0284c7', canvas: '#f6fafe', grid: '#e3edf7' },
  { id: 'blossom', name: 'Blossom', bg: '#fbeef4', bg2: '#fffdfe', bg3: '#f6e0eb', border: '#eac5d8', fg: '#2e1420', fg2: '#8a5470', accent: '#db2777', canvas: '#fef6fa', grid: '#f7e3ee' },
  { id: 'lavender', name: 'Lavender', bg: '#f2eefb', bg2: '#ffffff', bg3: '#e8e0f6', border: '#d5c5ec', fg: '#1f1330', fg2: '#644c84', accent: '#7c3aed', canvas: '#faf7fe', grid: '#ece3f7' },
  { id: 'sunrise', name: 'Sunrise', bg: '#fdf3e7', bg2: '#fffef9', bg3: '#f8e6d0', border: '#eecfae', fg: '#31200f', fg2: '#8a6a44', accent: '#ea580c', canvas: '#fef8f0', grid: '#f7ead7' },
  { id: 'sea', name: 'Sea Glass', bg: '#e9f6f6', bg2: '#ffffff', bg3: '#daeeee', border: '#bfdede', fg: '#0f2626', fg2: '#4a7676', accent: '#0d9488', canvas: '#f4fbfb', grid: '#e0f0f0' },
  { id: 'wheat', name: 'Wheat', bg: '#f8f4e8', bg2: '#fffef8', bg3: '#efe8d2', border: '#ddd2b0', fg: '#2a2410', fg2: '#7c7048', accent: '#ca8a04', canvas: '#fcf9ef', grid: '#f0ead8' },
  { id: 'rose', name: 'Rose', bg: '#fbeeee', bg2: '#fffdfd', bg3: '#f6e0e0', border: '#eac5c5', fg: '#2e1414', fg2: '#8a5454', accent: '#e11d48', canvas: '#fef6f6', grid: '#f7e3e3' },
  { id: 'cloud', name: 'Cloud', bg: '#f2f4f7', bg2: '#ffffff', bg3: '#e7eaef', border: '#d2d8e0', fg: '#1a1f28', fg2: '#5a6472', accent: '#475569', canvas: '#f8fafc', grid: '#eaedf2' },
  { id: 'pistachio', name: 'Pistachio', bg: '#f1f7e8', bg2: '#fffff9', bg3: '#e6efd4', border: '#cddfb0', fg: '#1f2a10', fg2: '#5e7040', accent: '#65a30d', canvas: '#f8fcf0', grid: '#eaf1da' },
  { id: 'porcelain', name: 'Porcelain', bg: '#f7f7f5', bg2: '#ffffff', bg3: '#ededea', border: '#dcdcd6', fg: '#232320', fg2: '#6b6b62', accent: '#0f766e', canvas: '#fbfbfa', grid: '#efefec' },
  { id: 'apricot', name: 'Apricot', bg: '#fdf1ea', bg2: '#fffdfa', bg3: '#f8e2d3', border: '#eecbb3', fg: '#301e12', fg2: '#8a6448', accent: '#c2410c', canvas: '#fef7f2', grid: '#f7e6da' },
  { id: 'periwinkle', name: 'Periwinkle', bg: '#eef0fb', bg2: '#ffffff', bg3: '#e2e5f6', border: '#c9cfec', fg: '#151830', fg2: '#525a84', accent: '#4f46e5', canvas: '#f6f7fe', grid: '#e6e9f7' },
  { id: 'honeydew', name: 'Honeydew', bg: '#eef8ef', bg2: '#ffffff', bg3: '#dff0e1', border: '#c4dec7', fg: '#122616', fg2: '#4e7052', accent: '#059669', canvas: '#f6fcf7', grid: '#e2f0e4' },
  { id: 'linen', name: 'Linen', bg: '#f7f4ef', bg2: '#fffefb', bg3: '#ece7dd', border: '#dbd3c5', fg: '#282219', fg2: '#786c58', accent: '#9a6b3f', canvas: '#fbf9f5', grid: '#efeae1' },
  { id: 'ice', name: 'Ice', bg: '#eef6f9', bg2: '#ffffff', bg3: '#deeef3', border: '#c2dde6', fg: '#0f2229', fg2: '#4a6c78', accent: '#0891b2', canvas: '#f5fbfd', grid: '#e2f0f4' },
  { id: 'orchid', name: 'Orchid', bg: '#f7eef9', bg2: '#fffdff', bg3: '#f0e0f4', border: '#ddc5e6', fg: '#26142e', fg2: '#78548a', accent: '#a21caf', canvas: '#fcf6fd', grid: '#f2e3f6' },
  { id: 'stone', name: 'Stone', bg: '#f5f4f2', bg2: '#ffffff', bg3: '#eae8e4', border: '#d8d5cf', fg: '#232220', fg2: '#6d6a63', accent: '#57534e', canvas: '#faf9f8', grid: '#eeece9' },
];
export const THEMES: Theme[] = [...DARK_SEEDS.map(s => build(s, true)), ...LIGHT_SEEDS.map(s => build(s, false))];
export function applyTheme(id: string) {
  const t = THEMES.find(x => x.id === id) ?? THEMES[0]!; const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.setAttribute('data-theme', t.dark ? 'dark' : 'light'); root.setAttribute('data-theme-id', t.id);
}
