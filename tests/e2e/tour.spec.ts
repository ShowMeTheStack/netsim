import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 1600, height: 900 } });

test('welcome tour shows on first run, steps through, and points to the Code feature', async ({ page }) => {
  // The shared storageState marks the tour as seen; clear it to simulate a genuine first run, then
  // reload (addInitScript would re-run on every navigation, so clear-then-reload is used instead).
  await page.goto('/');
  await page.evaluate(() => { try { localStorage.removeItem('netsim.tourSeen'); } catch { /* ignore */ } });
  await page.reload();

  await expect(page.getByTestId('tour')).toBeVisible();
  await expect(page.getByTestId('tour')).toContainText('Welcome to NetSim');

  // Step to the last card, which introduces C socket programming.
  for (let i = 0; i < 4; i++) await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour')).toContainText('C socket programs');
  await expect(page.getByTestId('tour')).toContainText('sandboxed');

  await page.getByTestId('tour-done').click();
  await expect(page.getByTestId('tour')).toHaveCount(0);

  // It stays dismissed on reload (the flag is now set), and reopens from the top bar.
  await page.reload();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await page.getByTestId('btn-tour').click();
  await expect(page.getByTestId('tour')).toBeVisible();
});
