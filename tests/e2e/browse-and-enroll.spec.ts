import { test, expect } from '@playwright/test';

/**
 * The path every visitor takes before they ever create an account: land on
 * the homepage, find the course, open a preview lesson. Nothing here needs
 * auth, so it is the cheapest possible smoke test that the gateway, the
 * catalog and the frontend rewrite are all actually wired together.
 */
test('browse the catalog and open a preview lesson without an account', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /courses/i }).first()).toBeVisible();

  await page.getByRole('link', { name: /courses/i }).first().click();
  await expect(page).toHaveURL(/\/courses/);

  const courseCard = page.getByRole('link', { name: /DevOps.*SRE/i }).first();
  await expect(courseCard).toBeVisible();
  await courseCard.click();

  await expect(page).toHaveURL(/\/courses\//);
  await expect(page.getByRole('heading', { name: /DevOps.*SRE/i })).toBeVisible();

  // The first module is marked preview in the seed data, so its first lesson
  // should be reachable without signing in.
  const previewLesson = page.getByRole('link', { name: /welcome/i }).first();
  await expect(previewLesson).toBeVisible();
  await previewLesson.click();
  await expect(page).toHaveURL(/\/learn\//);
  await expect(page.getByRole('heading')).toContainText(/welcome/i);
});
