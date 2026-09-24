import { test, expect, type Page } from '@playwright/test';
async function place(page: Page, id: string, x: number, y: number) { await page.getByTestId(`place-${id}`).click(); await page.getByTestId('canvas').click({ position: { x, y } }); await page.waitForTimeout(30); }
async function connect(page: Page, ax: number, ay: number, bx: number, by: number) { await page.getByTestId('tool-connect').click(); await page.getByTestId('canvas').click({ position: { x: ax, y: ay } }); await page.getByTestId('canvas').click({ position: { x: bx, y: by } }); await page.waitForTimeout(30); }
async function openNode(page: Page, x: number, y: number, tab?: string) { await page.getByTestId('tool-select').click(); await page.getByTestId('canvas').dblclick({ position: { x, y } }); await expect(page.getByTestId('node-popup')).toBeVisible(); if (tab) await page.getByTestId(`tab-${tab}`).click(); }
const close = (page: Page) => page.getByTestId('popup-close').click();
async function setIface(page: Page, iface: string, ip: string, prefix = '24') { await page.getByTestId(`ip-${iface}`).fill(ip); await page.getByTestId(`prefix-${iface}`).fill(prefix); await page.getByTestId(`apply-${iface}`).click(); }
async function cmd(page: Page, x: number, y: number, line: string) { await openNode(page, x, y, 'terminal'); await page.getByTestId('terminal-in').fill(line); await page.getByTestId('terminal-in').press('Enter'); await close(page); }
async function turbo(page: Page) { await page.getByTestId('btn-turbo').click(); await expect(page.getByTestId('btn-turbo')).not.toHaveClass(/active/, { timeout: 30000 }); }
const nodeCount = (page: Page) => page.evaluate(() => Object.keys((window as any).__netsim.get().st.nodes).length);

// A(10.0.1.10) - R1 - R2 - B(10.0.2.10), OSPF between routers; then set default routes on hosts to their gateways.
const A = [80, 260] as const, R1 = [240, 160] as const, R2 = [440, 160] as const, B = [600, 260] as const;
test('OSPF converges via the UI so two hosts across two routers can ping', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await place(page, 'laptop', ...A); await place(page, 'router', ...R1); await place(page, 'router', ...R2); await place(page, 'server', ...B);
  await expect.poll(() => nodeCount(page)).toBe(4);
  await connect(page, ...A, ...R1); await connect(page, ...R1, ...R2); await connect(page, ...R2, ...B);
  await openNode(page, ...A); await setIface(page, 'eth0', '10.0.1.10'); await page.getByTestId('gw').fill('10.0.1.1'); await page.getByTestId('gw-apply').click(); await close(page);
  await openNode(page, ...R1); await setIface(page, 'eth0', '10.0.1.1'); await setIface(page, 'eth1', '10.0.12.1'); await page.getByTestId('tab-routing').click(); await page.getByTestId('rt-ospf').click();
  await page.getByTestId('ospf-networks').fill('10.0.1.0/24\n10.0.12.0/24'); await page.getByTestId('ospf-enabled').click(); await close(page);
  await openNode(page, ...R2); await setIface(page, 'eth0', '10.0.12.2'); await setIface(page, 'eth1', '10.0.2.1'); await page.getByTestId('tab-routing').click(); await page.getByTestId('rt-ospf').click();
  await page.getByTestId('ospf-networks').fill('10.0.12.0/24\n10.0.2.0/24'); await page.getByTestId('ospf-enabled').click(); await close(page);
  await openNode(page, ...B); await setIface(page, 'eth0', '10.0.2.10'); await page.getByTestId('gw').fill('10.0.2.1'); await page.getByTestId('gw-apply').click(); await close(page);
  await turbo(page); // OSPF hellos + LSA flooding + SPF
  // R1 shows a full neighbor and an OSPF route to 10.0.2.0
  await openNode(page, ...R1, 'routing'); await page.getByTestId('rt-ospf').click();
  await expect(page.getByTestId('ospf-form')).toContainText('full');
  await close(page);
  await openNode(page, ...R1, 'routes'); await expect(page.getByTestId('routes-table')).toContainText('ospf'); await close(page);
  // now A can ping B end to end
  await cmd(page, ...A, 'ping -c 2 10.0.2.10'); await turbo(page);
  await openNode(page, ...A, 'terminal'); await expect(page.getByTestId('terminal-out')).toContainText('2 packets transmitted, 2 received'); await close(page);
});

test('NAT hides an inside host behind the router outside address', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  const IN = [80, 200] as const, RT = [280, 200] as const, OUT = [480, 200] as const;
  await place(page, 'laptop', ...IN); await place(page, 'router', ...RT); await place(page, 'server', ...OUT);
  await connect(page, ...IN, ...RT); await connect(page, ...RT, ...OUT);
  await openNode(page, ...IN); await setIface(page, 'eth0', '192.168.1.10'); await page.getByTestId('gw').fill('192.168.1.1'); await page.getByTestId('gw-apply').click(); await close(page);
  await openNode(page, ...RT); await setIface(page, 'eth0', '192.168.1.1'); await setIface(page, 'eth1', '203.0.113.1'); await page.getByTestId('tab-nat').click();
  await page.getByTestId('nat-outside').selectOption('eth1'); await page.getByTestId('nat-inside-eth0').click(); await page.getByTestId('nat-enabled').click(); await close(page);
  await openNode(page, ...OUT); await setIface(page, 'eth0', '203.0.113.9'); await page.getByTestId('gw').fill('203.0.113.1'); await page.getByTestId('gw-apply').click(); await close(page);
  await page.getByTestId('tool-sniff').click(); await page.getByTestId('canvas').click({ position: { x: 380, y: 200 } });
  await cmd(page, ...IN, 'ping -c 2 203.0.113.9'); await turbo(page);
  await openNode(page, ...IN, 'terminal'); await expect(page.getByTestId('terminal-out')).toContainText('2 packets transmitted, 2 received'); await close(page);
  // outside link shows the translated source, and the NAT table has an entry
  await page.getByTestId('display-filter').fill('icmp');
  const row = page.getByTestId('pk-row').filter({ hasText: '203.0.113.1' }).first(); await expect(row).toBeVisible();
  await openNode(page, ...RT, 'nat'); await expect(page.getByTestId('nat-table')).toContainText('192.168.1.10'); await close(page);
});
