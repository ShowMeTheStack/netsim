import { test, expect, type Page } from '@playwright/test';

// Canvas is at the app grid's center column. We place nodes by tool + click at known canvas coords.
async function place(page: Page, id: string, x: number, y: number) {
  await page.getByTestId(`place-${id}`).click();
  await expect(page.getByTestId('canvas-hint')).toContainText('place');
  await page.getByTestId('canvas').click({ position: { x, y } });
}
async function connect(page: Page, ax: number, ay: number, bx: number, by: number) {
  await page.getByTestId('tool-connect').click();
  await page.getByTestId('canvas').click({ position: { x: ax, y: ay } });
  await page.getByTestId('canvas').click({ position: { x: bx, y: by } });
}
async function openNode(page: Page, x: number, y: number) {
  await page.getByTestId('tool-select').click();
  await page.getByTestId('canvas').dblclick({ position: { x, y } });
  await expect(page.getByTestId('node-popup')).toBeVisible();
}
async function setIp(page: Page, x: number, y: number, ip: string) {
  await openNode(page, x, y);
  await page.getByTestId('tab-config').click();
  await page.getByTestId('ip-eth0').fill(ip); await page.getByTestId('prefix-eth0').fill('24');
  await page.getByTestId('apply-eth0').click();
  await page.getByTestId('popup-close').click();
}
const counts = (page: Page) => page.evaluate(() => { const s = (window as any).__netsim.get().st; return { nodes: Object.keys(s.nodes).length, links: Object.keys(s.links).length, sniffers: Object.keys(s.sniffers).length, time: s.time, mode: s.mode }; });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('NetSim');
  await expect(page.getByTestId('sim-time')).toContainText('t = 0.000000');
});

test('build a LAN, ping across a switch, sniff and inspect, step, break, save and load', async ({ page }) => {
  // ---- topology ----
  await place(page, 'laptop', 150, 150);
  await place(page, 'desktop', 450, 150);
  await place(page, 'switch', 300, 320);
  await expect.poll(async () => (await counts(page)).nodes).toBe(3);
  await connect(page, 150, 150, 300, 320);
  await connect(page, 450, 150, 300, 320);
  await expect.poll(async () => (await counts(page)).links).toBe(2);

  // ---- addressing via popup ----
  await setIp(page, 150, 150, '10.0.0.1');
  await setIp(page, 450, 150, '10.0.0.2');
  await openNode(page, 150, 150); await page.getByTestId('tab-routes').click();
  await expect(page.getByTestId('routes-table')).toContainText('10.0.0.0'); await page.getByTestId('popup-close').click();

  // ---- sniffer on laptop<->switch link (click its midpoint) ----
  await page.getByTestId('tool-sniff').click();
  await page.getByTestId('canvas').click({ position: { x: 225, y: 235 } });
  await expect.poll(async () => (await counts(page)).sniffers).toBe(1);
  await expect(page.getByTestId('sniffer-tab-1')).toBeVisible();

  // ---- ping from the terminal, run in turbo ----
  await openNode(page, 150, 150); await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('ping -c 3 10.0.0.2'); await page.getByTestId('terminal-in').press('Enter');
  await expect(page.getByTestId('terminal-out')).toContainText('PING 10.0.0.2');
  await page.getByTestId('popup-close').click();
  await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('btn-turbo')).not.toHaveClass(/active/, { timeout: 15000 }); // turbo stops when idle
  await openNode(page, 150, 150); await page.getByTestId('tab-terminal').click();
  await expect(page.getByTestId('terminal-out')).toContainText('3 packets transmitted, 3 received, 0% packet loss');
  await expect(page.getByTestId('terminal-out')).toContainText('icmp_seq=1 ttl=64');
  await page.getByTestId('tab-arp').click(); await expect(page.getByTestId('arp-table')).toContainText('10.0.0.2');
  await page.getByTestId('popup-close').click();
  const t1 = (await counts(page)).time; expect(t1).toBeGreaterThan(2_000_000);

  // ---- switch learned both MACs ----
  await openNode(page, 300, 320); await page.getByTestId('tab-mac').click();
  await expect(page.getByTestId('mac-table')).toContainText('02:00:00:01:00:00'); await expect(page.getByTestId('mac-table')).toContainText('02:00:00:02:00:00');
  await page.getByTestId('popup-close').click();

  // ---- capture: ARP then ICMP, Wireshark-style rows; inspect a packet ----
  const rows = page.getByTestId('pk-row');
  await expect(rows).toHaveCount(8); // 2 ARP + 3 echo + 3 reply on that link
  await expect(rows.nth(0)).toContainText('ARP'); await expect(rows.nth(0)).toContainText('Who has 10.0.0.2? Tell 10.0.0.1');
  await expect(rows.nth(1)).toContainText('10.0.0.2 is at 02:00:00:02:00:00');
  await expect(rows.nth(2)).toContainText('ICMP'); await expect(rows.nth(2)).toContainText('Echo (ping) request');
  await rows.nth(2).click();
  const det = page.getByTestId('packet-details'); await expect(det).toBeVisible();
  await expect(det.getByTestId('layer-eth')).toContainText('Ethernet II'); await expect(det.getByTestId('layer-ipv4')).toContainText('Time to Live: 64'); await expect(det.getByTestId('layer-icmp')).toContainText('Identifier');
  await expect(det.getByTestId('layer-ipv4')).toContainText('[correct]'); await expect(det.getByTestId('layer-eth')).toContainText('[correct]');
  await expect(page.getByTestId('hexdump')).toContainText('0000');
  // hover a field -> hex highlight appears
  await det.getByTestId('layer-ipv4').getByText('Time to Live').hover();
  await expect(page.locator('.hex .hl').first()).toBeVisible();

  // ---- display filter ----
  await page.getByTestId('display-filter').fill('icmp.type == 0');
  await expect(page.getByTestId('pk-count')).toHaveText('3/8');
  await page.getByTestId('display-filter').fill('arp or icmp.type == 8');
  await expect(page.getByTestId('pk-count')).toHaveText('5/8');
  await page.getByTestId('display-filter').fill('bogus ==');
  await expect(page.getByTestId('display-filter')).toHaveClass(/invalid/);
  await page.getByTestId('display-filter').fill('');

  // ---- restart, stepping and breakpoints ----
  await page.getByTestId('btn-restart').click();
  await expect(page.getByTestId('sim-time')).toContainText('t = 0.000000');
  await expect(rows).toHaveCount(0);
  await page.getByTestId('tab-breakpoints').click();
  await page.getByTestId('bp-expr').fill('arp.opcode == 2'); await page.getByTestId('bp-add').click();
  await expect(page.getByTestId('bp-row')).toHaveCount(1);
  await openNode(page, 450, 150); await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('ping -c 1 10.0.0.1'); await page.getByTestId('terminal-in').press('Enter'); await page.getByTestId('popup-close').click();
  await page.getByTestId('btn-step-packet').click();
  await expect(page.getByTestId('sim-time')).not.toContainText('t = 0.000000');
  const afterStep = (await counts(page)).time; expect(afterStep).toBeLessThan(10_000); // the very first ARP tx is at t≈0
  await page.getByTestId('btn-play').click();
  await expect(page.getByTestId('bp-hit')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('bp-hit')).toContainText('is at');
  await expect.poll(async () => (await counts(page)).mode).toBe('paused');
  await page.getByTestId('btn-step-event').click();
  // The same ARP reply is re-transmitted by the switch on the next link, so the breakpoint fires again.
  await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('bp-hit')).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await counts(page)).mode).toBe('paused');
  const bpCheck = page.getByTestId('bp-row').locator('input[type=checkbox]');
  await bpCheck.click(); await expect(bpCheck).not.toBeChecked();
  await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('btn-turbo')).not.toHaveClass(/active/, { timeout: 15000 });
  await openNode(page, 450, 150); await page.getByTestId('tab-terminal').click();
  await expect(page.getByTestId('terminal-out')).toContainText('1 packets transmitted, 1 received'); await page.getByTestId('popup-close').click();

  // ---- link properties: 100% loss makes pings fail and the sniffer shows the drop ----
  await page.getByTestId('canvas').dblclick({ position: { x: 225, y: 235 } });
  await expect(page.getByTestId('link-popup')).toBeVisible();
  await page.getByTestId('link-loss').fill('100'); await page.getByTestId('link-apply').click(); await page.getByTestId('popup-close').click();
  await openNode(page, 150, 150); await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('ping -c 1 10.0.0.2'); await page.getByTestId('terminal-in').press('Enter'); await page.getByTestId('popup-close').click();
  await page.getByTestId('btn-turbo').click(); await expect(page.getByTestId('btn-turbo')).not.toHaveClass(/active/, { timeout: 15000 });
  await expect(page.locator('tr.dropped').first()).toBeVisible();
  await openNode(page, 150, 150); await page.getByTestId('tab-terminal').click();
  await expect(page.getByTestId('terminal-out')).toContainText('100% packet loss'); await page.getByTestId('popup-close').click();

  // ---- theme switch ----
  await page.getByTestId('theme').selectOption('daylight');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // ---- save, new, load ----
  const dl = page.waitForEvent('download');
  await page.getByTestId('btn-save').click();
  const file = await dl; const path = await file.path(); expect(path).toBeTruthy();
  const fs = await import('node:fs'); const json = JSON.parse(fs.readFileSync(path!, 'utf8'));
  expect(json.format).toBe('netsim-session'); expect(Object.keys(json.state.nodes)).toHaveLength(3); expect(json.state.time).toBeGreaterThan(0);
  page.on('dialog', d => d.accept());
  await page.getByTestId('btn-new').click();
  await expect.poll(async () => (await counts(page)).nodes).toBe(0);
  await page.getByTestId('file-input').setInputFiles(path!);
  await expect(page.getByTestId('toast')).toContainText('Session loaded');
  const c = await counts(page); expect(c.nodes).toBe(3); expect(c.links).toBe(2); expect(c.sniffers).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(rows.first()).toBeVisible(); // captures came back too
  await openNode(page, 150, 150); await page.getByTestId('tab-terminal').click();
  await expect(page.getByTestId('terminal-out')).toContainText('100% packet loss'); // terminal history restored
});

test('security: app makes no network requests beyond its own origin', async ({ page }) => {
  const external: string[] = [];
  page.on('request', r => { const u = new URL(r.url()); if (u.hostname !== '127.0.0.1') external.push(r.url()); });
  await place(page, 'laptop', 150, 150); await page.getByTestId('btn-turbo').click(); await page.waitForTimeout(500);
  expect(external).toEqual([]);
});
