import { test, expect, type Page } from '@playwright/test';

async function place(page: Page, id: string, x: number, y: number) { await page.getByTestId(`place-${id}`).click(); await page.getByTestId('canvas').click({ position: { x, y } }); await expect.poll(async () => nodeCount(page)).toBeGreaterThan(0); }
async function connect(page: Page, ax: number, ay: number, bx: number, by: number) { await page.getByTestId('tool-connect').click(); await page.getByTestId('canvas').click({ position: { x: ax, y: ay } }); await page.getByTestId('canvas').click({ position: { x: bx, y: by } }); }
async function openNode(page: Page, x: number, y: number, tab?: string) { await page.getByTestId('tool-select').click(); await page.getByTestId('canvas').dblclick({ position: { x, y } }); await expect(page.getByTestId('node-popup')).toBeVisible(); if (tab) await page.getByTestId(`tab-${tab}`).click(); }
const close = (page: Page) => page.getByTestId('popup-close').click();
async function setIface(page: Page, iface: string, ip: string) { await page.getByTestId(`ip-${iface}`).fill(ip); await page.getByTestId(`prefix-${iface}`).fill('24'); await page.getByTestId(`apply-${iface}`).click(); }
async function cmd(page: Page, x: number, y: number, line: string) { await openNode(page, x, y, 'terminal'); await page.getByTestId('terminal-in').fill(line); await page.getByTestId('terminal-in').press('Enter'); await close(page); }
async function turboUntilIdle(page: Page) { await page.getByTestId('btn-turbo').click(); await expect(page.getByTestId('btn-turbo')).not.toHaveClass(/active/, { timeout: 30000 }); }
const nodeCount = (page: Page) => page.evaluate(() => Object.keys((window as any).__netsim.get().st.nodes).length);
const stateOf = (page: Page) => page.evaluate(() => { const s = (window as any).__netsim.get().st; return { links: Object.keys(s.links).length, mode: s.mode, time: s.time }; });

// Laptop(A) — R1 — R2 — Server(B): 10.0.1.0/24, 10.0.12.0/24, 10.0.2.0/24
const A = [70, 100] as const, R1 = [220, 100] as const, R2 = [370, 100] as const, B = [520, 100] as const;

test('routed topology: traceroute, PMTU, iperf with impairment, sockets panel and charts', async ({ page }) => {
  await page.goto('/');
  await place(page, 'laptop', ...A); await place(page, 'router', ...R1); await place(page, 'router', ...R2); await place(page, 'server', ...B);
  await expect.poll(() => nodeCount(page)).toBe(4);
  await connect(page, ...A, ...R1); await connect(page, ...R1, ...R2); await connect(page, ...R2, ...B);
  await expect.poll(async () => (await stateOf(page)).links).toBe(3);

  // addressing + routes via popups
  await openNode(page, ...A); await setIface(page, 'eth0', '10.0.1.10'); await page.getByTestId('gw').fill('10.0.1.1'); await page.getByTestId('gw-apply').click(); await close(page);
  await openNode(page, ...R1); await expect(page.getByTestId('forwarding')).toBeChecked(); await setIface(page, 'eth0', '10.0.1.1'); await setIface(page, 'eth1', '10.0.12.1');
  await page.getByTestId('tab-routes').click(); await page.getByTestId('route-cidr').fill('10.0.2.0/24'); await page.getByTestId('route-gw').fill('10.0.12.2'); await page.getByTestId('route-add').click(); await expect(page.getByTestId('routes-table')).toContainText('10.0.12.2'); await close(page);
  await openNode(page, ...R2); await setIface(page, 'eth0', '10.0.12.2'); await setIface(page, 'eth1', '10.0.2.1');
  await page.getByTestId('tab-routes').click(); await page.getByTestId('route-cidr').fill('10.0.1.0/24'); await page.getByTestId('route-gw').fill('10.0.12.1'); await page.getByTestId('route-add').click(); await expect(page.getByTestId('routes-table')).toContainText('10.0.12.1'); await close(page);
  await openNode(page, ...B); await setIface(page, 'eth0', '10.0.2.10'); await page.getByTestId('gw').fill('10.0.2.1'); await page.getByTestId('gw-apply').click(); await close(page);

  // traceroute across both routers
  await cmd(page, ...A, 'traceroute 10.0.2.10'); await turboUntilIdle(page);
  await openNode(page, ...A, 'terminal'); const out = page.getByTestId('terminal-out');
  await expect(out).toContainText('1  10.0.1.1'); await expect(out).toContainText('2  10.0.12.2'); await expect(out).toContainText('3  10.0.2.10'); await close(page);

  // PMTU: shrink the middle link's router MTUs via terminal, DF ping reports frag needed
  await cmd(page, ...R1, 'ip link set eth1 mtu 600'); await cmd(page, ...R2, 'ip link set eth0 mtu 600');
  await cmd(page, ...A, 'ping -c 1 -M do -s 1400 10.0.2.10'); await turboUntilIdle(page);
  await openNode(page, ...A, 'terminal'); await expect(out).toContainText('Frag needed and DF set (mtu = 600)'); await close(page);
  await cmd(page, ...R1, 'ip link set eth1 mtu 1500'); await cmd(page, ...R2, 'ip link set eth0 mtu 1500');

  // bottleneck: R1-R2 link to 5 Mbps via link popup, then iperf; inject one drop mid-transfer
  await page.getByTestId('tool-select').click(); await page.getByTestId('canvas').dblclick({ position: { x: 295, y: 100 } }); await expect(page.getByTestId('link-popup')).toBeVisible();
  await page.getByTestId('link-bw').fill('5'); await page.getByTestId('link-bw-rev').fill('5'); await page.getByTestId('link-apply').click(); await close(page);
  await cmd(page, ...B, 'iperf -s'); await cmd(page, ...A, 'iperf -c 10.0.2.10 -n 1500000');
  await page.getByTestId('btn-play').click(); await page.waitForTimeout(700);
  await page.getByTestId('canvas').dblclick({ position: { x: 295, y: 100 } }); await expect(page.getByTestId('link-popup')).toBeVisible();
  await page.getByTestId('impair-dir').selectOption('ab'); await page.getByTestId('impair-filter').fill('tcp.len > 0'); await page.getByTestId('impair-drop').fill('1'); await page.getByTestId('impair-apply').click(); await close(page);
  await page.getByTestId('btn-pause').click().catch(() => {}); await turboUntilIdle(page);
  await openNode(page, ...A, 'terminal'); await expect(out).toContainText(/0\.0-\s*[\d.]+ sec\s+1\.\d+ MBytes/); await close(page);
  await openNode(page, ...B, 'terminal'); await expect(page.getByTestId('terminal-out')).toContainText('[SRV]'); await close(page);

  // sockets tab: connection detail, fast retransmit recorded, charts rendered
  await openNode(page, ...A, 'sockets');
  await expect(page.getByTestId('sockets-table')).toContainText('CLOSED'); await expect(page.getByTestId('sockets-table')).toContainText('history');
  const detail = page.getByTestId('tcp-detail'); await expect(detail).toBeVisible();
  await expect(detail).toContainText('RENO'); await expect(detail.locator('text=fast retx')).toBeVisible();
  const fastRetx = await detail.evaluate(el => { const m = /fast retx\s*(\d+)/.exec(el.textContent ?? ''); return m ? Number(m[1]) : -1; }); expect(fastRetx).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('chart-cwnd')).toBeVisible(); await expect(page.getByTestId('chart-rtt')).toBeVisible(); await expect(page.getByTestId('chart-seq')).toBeVisible();
  await page.locator('summary', { hasText: 'Connection log' }).click(); await expect(page.getByTestId('tcp-log')).toContainText('fast retransmit');
  // switching congestion control from the UI is reflected in the terminal sysctl
  await page.getByTestId('tab-config').click(); await page.getByTestId('tcp-cc').selectOption('cubic'); await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('sysctl net.ipv4.tcp_congestion_control'); await page.getByTestId('terminal-in').press('Enter'); await expect(out).toContainText('net.ipv4.tcp_congestion_control = cubic');
  await close(page);
});
