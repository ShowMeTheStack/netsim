import { test, expect, type Page } from '@playwright/test';
async function place(page: Page, id: string, x: number, y: number) { await page.getByTestId(`place-${id}`).click(); await page.getByTestId('canvas').click({ position: { x, y } }); await page.waitForTimeout(30); }
async function connect(page: Page, ax: number, ay: number, bx: number, by: number) { await page.getByTestId('tool-connect').click(); await page.getByTestId('canvas').click({ position: { x: ax, y: ay } }); await page.getByTestId('canvas').click({ position: { x: bx, y: by } }); await page.waitForTimeout(30); }
async function openNode(page: Page, x: number, y: number, tab?: string) { await page.getByTestId('tool-select').click(); await page.getByTestId('canvas').dblclick({ position: { x, y } }); await expect(page.getByTestId('node-popup')).toBeVisible(); if (tab) await page.getByTestId(`tab-${tab}`).click(); }
const close = (page: Page) => page.getByTestId('popup-close').click();
async function setIface(page: Page, iface: string, ip: string) { await page.getByTestId(`ip-${iface}`).fill(ip); await page.getByTestId(`apply-${iface}`).click(); }
async function cmd(page: Page, x: number, y: number, line: string) { await openNode(page, x, y, 'terminal'); await page.getByTestId('terminal-in').fill(line); await page.getByTestId('terminal-in').press('Enter'); await close(page); }
async function turbo(page: Page) { await page.getByTestId('btn-turbo').click(); await expect(page.getByTestId('btn-turbo')).not.toHaveClass(/active/, { timeout: 30000 }); }
const nodeCount = (page: Page) => page.evaluate(() => Object.keys((window as any).__netsim.get().st.nodes).length);

const GW = [90, 90] as const, SW = [250, 200] as const, CLIENT = [90, 300] as const, SRV = [420, 90] as const;

test('DHCP lease, DNS resolution and HTTP fetch through the UI', async ({ page }) => {
  await page.goto('/');
  await place(page, 'router', ...GW); await place(page, 'switch', ...SW); await place(page, 'laptop', ...CLIENT); await place(page, 'server', ...SRV);
  await expect.poll(() => nodeCount(page)).toBe(4);
  await connect(page, ...GW, ...SW); await connect(page, ...CLIENT, ...SW); await connect(page, ...SRV, ...SW);

  // GW: address + DHCP server serving DNS = the server's IP
  await openNode(page, ...GW); await setIface(page, 'eth0', '10.0.0.1'); await close(page);
  await openNode(page, ...SRV); await setIface(page, 'eth0', '10.0.0.53'); await close(page);
  await openNode(page, ...GW, 'services'); await page.getByTestId('svc-dhcp').click();
  await page.getByTestId('dhcp-start').fill('10.0.0.100'); await page.getByTestId('dhcp-end').fill('10.0.0.150'); await page.getByTestId('dhcp-gw').fill('10.0.0.1'); await page.getByTestId('dhcp-dns').fill('10.0.0.53');
  await page.getByTestId('dhcp-enabled').check(); await page.getByTestId('dhcp-apply').click(); await close(page);

  // SRV: authoritative DNS zone + HTTP docroot
  await openNode(page, ...SRV, 'services'); await page.getByTestId('svc-dns').click();
  await page.getByTestId('zone-origin').fill('test.local');
  await page.getByTestId('zone-text').fill('$TTL 300\nwww IN A 10.0.0.53\n@ IN A 10.0.0.53\n');
  await page.getByTestId('zone-save').click();
  await page.getByTestId('svc-http').click();
  await page.getByTestId('docfile-index.html').click();
  await page.getByTestId('docfile-text').fill('<html><head><link rel="stylesheet" href="/site.css"></head><body><h1>NetSim</h1><img src="/pic.png"></body></html>');
  await page.getByTestId('docfile-save').click();
  await page.getByTestId('docfile-new').fill('site.css'); await page.getByText('+ Add').click(); await page.getByTestId('docfile-text').fill('h1 { color: teal; }'); await page.getByTestId('docfile-save').click();
  await page.getByTestId('docfile-new').fill('pic.png'); await page.getByText('+ Add').click(); await page.getByTestId('docfile-text').fill('PNGPNGPNG'); await page.getByTestId('docfile-save').click();
  await close(page);
  await cmd(page, ...SRV, 'httpd');

  // attach a sniffer to the client link up front so it captures DHCP, DNS and HTTP
  await page.getByTestId('tool-sniff').click(); await page.getByTestId('canvas').click({ position: { x: 170, y: 250 } });

  // client requests a DHCP lease
  await cmd(page, ...CLIENT, 'dhclient'); await turbo(page);
  await openNode(page, ...CLIENT, 'terminal');
  await expect(page.getByTestId('terminal-out')).toContainText('DHCPACK'); await expect(page.getByTestId('terminal-out')).toContainText('bound to 10.0.0.100');
  await close(page);
  // DNS server config on client for name lookups (dhcp provided it, but also set explicitly via hosts not needed)
  await cmd(page, ...CLIENT, 'dig www.test.local'); await turbo(page);
  await openNode(page, ...CLIENT, 'terminal'); await expect(page.getByTestId('terminal-out')).toContainText('10.0.0.53'); await expect(page.getByTestId('terminal-out')).toContainText('status: NOERROR'); await close(page);

  // fetch the page + resources by hostname (sniffer already attached to the client link)
  await cmd(page, ...CLIENT, 'curl http://www.test.local/'); await turbo(page);
  await openNode(page, ...CLIENT, 'terminal');
  await expect(page.getByTestId('terminal-out')).toContainText('200 OK'); await expect(page.getByTestId('terminal-out')).toContainText('references 2 resource'); await expect(page.getByTestId('terminal-out')).toContainText('Fetched 3 resource');
  await page.getByTestId('tab-http').click(); await expect(page.getByTestId('waterfall')).toBeVisible(); await expect(page.getByTestId('waterfall')).toContainText('/site.css'); await expect(page.getByTestId('waterfall')).toContainText('200');
  await close(page);

  // the sniffer shows DHCP, DNS and HTTP decoded
  await page.getByTestId('display-filter').fill('dhcp'); await expect.poll(async () => Number(await page.getByTestId('pk-count').textContent().then(t => t?.split('/')[0]))).toBeGreaterThan(0);
  await page.getByTestId('display-filter').fill('dns'); await expect.poll(async () => Number(await page.getByTestId('pk-count').textContent().then(t => t?.split('/')[0]))).toBeGreaterThan(0);
  await page.getByTestId('display-filter').fill('http'); await expect.poll(async () => Number(await page.getByTestId('pk-count').textContent().then(t => t?.split('/')[0]))).toBeGreaterThan(0);
  const httpRow = page.getByTestId('pk-row').filter({ hasText: 'GET' }).first(); await httpRow.click();
  await expect(page.getByTestId('layer-http')).toContainText('Hypertext Transfer Protocol');
  await page.getByTestId('display-filter').fill('');
});
