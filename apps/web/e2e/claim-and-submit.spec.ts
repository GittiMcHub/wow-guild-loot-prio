import { expect, test } from '@playwright/test';

/**
 * M4's required E2E flow: claim invite → build both lists → submit → verify
 * locked. Bootstraps a throwaway guild/phase/admin directly against the API
 * (E2E_API_URL, default http://localhost:3000) so the test is self-contained.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

async function apiFetch(path: string, init?: RequestInit & { cookie?: string }) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.cookie ? { Cookie: init.cookie } : {}), ...init?.headers },
  });
  return res;
}

test('claim an invite, build both lists in the browser, submit, and verify it is locked', async ({ page }) => {
  const suffix = Date.now();

  // Provisioning a throwaway guild isn't exposed over HTTP (§3A.7 is a CLI),
  // so bootstrap against the instance's already-seeded demo guild instead.
  const login = await apiFetch(`/api/g/nightfall/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'ChangeMe!Demo123' }),
  });
  expect(login.ok, await login.text()).toBe(true);
  const setCookie = login.headers.get('set-cookie') ?? '';
  const cookie = setCookie
    .split(/,(?=[^ ]+=)/)
    .map((c) => c.split(';')[0])
    .join('; ');

  const phasesRes = await apiFetch('/api/phases', { cookie });
  const { phases } = (await phasesRes.json()) as { phases: Array<{ id: string; key: string }> };
  const phase = phases.find((p) => p.key === 'P3')!;

  const inviteRes = await apiFetch(`/api/phases/${phase.id}/invites`, {
    method: 'POST',
    cookie,
    body: JSON.stringify({ kind: 'GENERIC', maxUses: 1 }),
  });
  const { invites } = (await inviteRes.json()) as { invites: Array<{ url: string }> };
  const token = invites[0]!.url.split('/i/')[1]!;

  // --- claim the invite in the real browser ---
  await page.goto(`/i/${token}`);
  await expect(page.getByRole('heading', { name: /Phase 3/i })).toBeVisible();

  await page.getByLabel('Discord / display name').fill(`E2E Player ${suffix}`);
  await page.getByLabel('Character name').fill(`E2EChar${suffix}`);
  await page.getByLabel('Class').selectOption('WARRIOR');
  await page.getByLabel('Main spec').fill('FURY');
  await page.getByLabel('Off spec').fill('PROTECTION');
  await page.getByRole('button', { name: 'Join' }).click();

  await expect(page.getByText('Save this link!')).toBeVisible();
  const linkText = await page.locator('code').innerText();
  const playerPath = new URL(linkText).pathname;

  // --- build both lists ---
  await page.goto(playerPath);
  await expect(page.getByRole('heading', { name: `E2E Player ${suffix}` })).toBeVisible();

  await page.getByRole('button', { name: /\+ Add for E2EChar/ }).first().click();
  await page.getByPlaceholder('Search by name or item ID…').fill('');
  await page.locator('ul li button').first().click();
  await expect(page.getByText('1 of')).toBeVisible();

  await page.getByRole('button', { name: 'Off list' }).click();
  // Target the second slot row (Neck) so MAIN and OFF pick different slots.
  await page.getByRole('button', { name: /\+ Add for E2EChar/ }).nth(1).click();
  await page.locator('ul li button').first().click();
  await expect(page.getByText('1 of')).toBeVisible();

  // wait for the debounced autosave to fire and settle
  await expect(page.getByText(/Saved/)).toBeVisible({ timeout: 5000 });

  // --- submit ---
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByLabel('Type SUBMIT to confirm').fill('SUBMIT');
  await page.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();

  await expect(page.getByText('Submitted (read-only)')).toBeVisible();

  // --- verify it's locked: a second submit attempt via the API is rejected ---
  const submitAgain = await apiFetch('/api/me/submission/submit', {
    method: 'POST',
    body: '{}',
    headers: { Authorization: `Bearer ${playerPath.split('/b/')[1]}` },
  });
  expect(submitAgain.status).toBe(409);
});
