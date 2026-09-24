import { test, expect, type Page } from '@playwright/test';
async function turbo(page: Page) { await page.getByTestId('btn-turbo').click(); await expect(page.getByTestId('btn-turbo')).not.toHaveClass(/active/, { timeout: 30000 }); }
const nodeCount = (page: Page) => page.evaluate(() => Object.keys((window as any).__netsim.get().st.nodes).length);

test('Wi-Fi lab: associate over the air and ping the server, inspect air frames and encoding', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.getByTestId('labs').click(); await page.getByTestId('launch-wifi-assoc').click();
  await expect(page.getByTestId('lab-drawer')).toContainText('Associating with an access point');
  await page.getByTestId('lab-collapse').click(); // hide the drawer to free the canvas
  await expect.poll(() => nodeCount(page)).toBe(3);
  // add an air monitor and turn the laptop into a Wi-Fi station via its config (Laptop is at ~200,160)
  await page.getByTestId('add-air').click();
  await page.getByTestId('tool-select').click(); await page.getByTestId('canvas').dblclick({ position: { x: 200, y: 160 } });
  await expect(page.getByTestId('node-popup')).toBeVisible();
  await expect(page.getByTestId('node-name')).toHaveValue('Laptop');
  await page.getByTestId('wifi-eth0').click();
  await page.getByTestId('wifi-ssid-eth0').fill('netsim-lab'); await page.getByTestId('wifi-ssid-eth0').blur();
  await page.getByTestId('popup-close').click();
  await turbo(page); // associate via beacons
  // ping the server
  await page.getByTestId('canvas').dblclick({ position: { x: 200, y: 160 } }); await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('ping -c 3 10.0.0.20'); await page.getByTestId('terminal-in').press('Enter'); await page.getByTestId('popup-close').click();
  await turbo(page);
  await page.getByTestId('lab-reopen').click();
  await expect(page.getByTestId('lab-drawer')).toContainText('2/2');
  // air monitor shows beacons and data; inspect the physical-layer encoding of a frame
  await page.getByTestId('air-tab-1').click();
  // beacons are hidden by default so the data/ACK frames are easy to find
  await expect(page.getByTestId('air-list')).toContainText('DATA');
  await page.getByTestId('air-hide-beacons').uncheck();
  await expect(page.getByTestId('air-list')).toContainText('BEACON');
  await page.getByTestId('air-hide-beacons').check();
  await page.getByTestId('air-row').filter({ hasText: 'DATA' }).first().click();
  await page.getByTestId('phys-toggle').click();
  await expect(page.getByTestId('phys-canvas')).toBeVisible();
  await page.getByTestId('enc-manchester').click(); await page.getByTestId('enc-4b5b').click();
});

test('40 themes switch cleanly between light and dark', async ({ page }) => {
  await page.goto('/');
  const opts = await page.getByTestId('theme').evaluate((el: HTMLSelectElement) => Array.from(el.options).map(o => o.value).filter(Boolean));
  expect(opts.length).toBe(40);
  await page.getByTestId('theme').selectOption('forest'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('theme').selectOption('blossom'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'blossom');
});

test('ARP spoofing lab poisons the victim cache', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.getByTestId('labs').click(); await page.getByTestId('launch-sec-arpspoof').click();
  await expect(page.getByTestId('lab-drawer')).toContainText('ARP spoofing');
  // Fold the guide so it does not cover the Attacker node on the right of the canvas.
  await page.getByTestId('lab-collapse').click();
  const attacker = { x: 620, y: 340 };
  await page.getByTestId('tool-select').click(); await page.getByTestId('canvas').dblclick({ position: attacker });
  await expect(page.getByTestId('node-name')).toHaveValue('Attacker');
  await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('arpspoof 10.0.0.1'); await page.getByTestId('terminal-in').press('Enter'); await page.getByTestId('popup-close').click();
  await turbo(page);
  // Verify the poisoning in engine state (authoritative) and via the lab check.
  await expect.poll(async () => page.evaluate(() => { const v: any = Object.values((window as any).__netsim.get().st.nodes).find((n: any) => n.name === 'Victim'); return v?.arp?.['10.0.0.1']?.mac ?? null; }), { timeout: 15000 }).toBe('02:00:00:04:00:00');
  await page.getByTestId('lab-reopen').click(); await expect(page.getByTestId('lab-drawer')).toContainText('1/1');
});
