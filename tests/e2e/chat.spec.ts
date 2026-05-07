import { test, expect } from '@playwright/test';

const SAP_USER = process.env.E2E_SAP_USER ?? 'admin';
const SAP_PASSWORD = process.env.E2E_SAP_PASSWORD;

test.describe('ADK chat — end-to-end', () => {
  test('E1 — basic login then RAG-only chat returns an assistant message', async ({ page, request }) => {
    test.skip(!SAP_PASSWORD, 'E2E_SAP_PASSWORD not set (see tests/e2e/README.md)');
    const auth = await request.post('/api/sap/auth', {
      data: { method: 'basic', username: SAP_USER, password: SAP_PASSWORD },
    });
    expect(auth.ok(), `auth failed: ${auth.status()} ${await auth.text()}`).toBe(true);

    await page.goto('/chat');
    const input = page.getByPlaceholder(/ask|질문|message/i).first();
    await input.fill('업로드된 문서 요약해줘');
    await input.press('Enter');

    const assistant = page.getByTestId('assistant-message').first();
    await expect(assistant).toBeVisible({ timeout: 30_000 });
    await expect(assistant).not.toBeEmpty();
  });

  test('E2 — SAP query returns tabular results', async ({ page, request }) => {
    test.skip(!SAP_PASSWORD, 'E2E_SAP_PASSWORD not set (see tests/e2e/README.md)');
    const auth = await request.post('/api/sap/auth', {
      data: { method: 'basic', username: SAP_USER, password: SAP_PASSWORD },
    });
    expect(auth.ok()).toBe(true);

    await page.goto('/chat');
    const input = page.getByPlaceholder(/ask|질문|message/i).first();
    await input.fill('FERT 타입 제품 5개 보여줘');
    await input.press('Enter');

    const tableOrAssistant = page.locator('table, [data-testid="assistant-message"]').first();
    await expect(tableOrAssistant).toBeVisible({ timeout: 60_000 });
  });

  test('E3 — request without session is gated', async ({ request }) => {
    const res = await request.post('/api/chat', {
      data: { conversationId: '00000000-0000-0000-0000-000000000000', message: 'hi' },
    });
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401);
  });
});
