import { test, expect } from '@playwright/test';

/**
 * Register -> verify (via MailHog's own API, since no human is reading mail in
 * CI) -> log in -> land on an empty dashboard. This is the one flow that
 * touches auth-service, its Postgres, MailHog and the frontend cookie handling
 * all in one pass.
 */
test('a new visitor can register, verify by mail, and reach their dashboard', async ({ page, request }) => {
  const email = `pw-${Date.now()}@example.com`;
  const password = 'Correct-Horse-9';

  await page.goto('/register');
  await page.getByLabel(/full name/i).fill('Playwright User');
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel(/^password/i).fill(password);
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/login\?registered=1/);

  // Pull the verification link out of MailHog rather than parsing HTML by eye.
  const mailhog = process.env.MAILHOG_API_URL ?? 'http://localhost:8025';
  const messages = await request.get(`${mailhog}/api/v2/messages`).then((r) => r.json());
  const msg = messages.items.find((m: any) => m.To?.[0]?.Mailbox + '@' + m.To?.[0]?.Domain === email);
  expect(msg, 'verification email should have arrived in MailHog').toBeTruthy();

  const body: string = msg.Content.Body;
  const match = body.match(/token=([A-Za-z0-9_-]{20,})/);
  expect(match, 'verification link should contain a token').toBeTruthy();

  await page.goto(`/verify-email?token=${match![1]}`);
  await expect(page.getByText(/verified/i)).toBeVisible();

  await page.getByRole('link', { name: /continue to sign in/i }).click();
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(/welcome back/i)).toBeVisible();
});
