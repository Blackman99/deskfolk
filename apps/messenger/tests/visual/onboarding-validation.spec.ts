import { chromium, expect, test, webkit } from '@playwright/test';
import { copyFor } from '../../src/lib/copy.ts';

const t = copyFor('zh');

for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
  for (const width of [1000, 390]) {
    test(`${engineName} ${width}px: onboarding disables invalid steps and enables them after correction`, async ({ baseURL }) => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
        await page.goto(`${baseURL}index.html?story=onboarding-validation&theme=light`);
        await page.waitForSelector('html[data-ready="yes"]');
        const workspaceNext = page.getByRole('button', { name: `${t.onboarding.step1Next} →`, exact: true });
        const providerNext = page.getByRole('button', { name: `${t.onboarding.step2Next} →`, exact: true });
        const modelsNext = page.getByRole('button', { name: `${t.onboarding.step3Next} →`, exact: true });
        const createBot = page.getByRole('button', { name: `${t.onboarding.createBot} ✓`, exact: true });
        const modelsTab = page.locator('.step-bar-item').filter({ hasText: t.onboarding.step3Title });

        await expect(workspaceNext).toBeDisabled();
        expect(await workspaceNext.evaluate((button) => Number(getComputedStyle(button).opacity))).toBeLessThan(1);
        await modelsTab.click();
        await expect(page.locator('.step-pane-title')).toHaveText(t.onboarding.stepWorkspace);
        await expect(page.locator('.field-error')).toHaveText(t.settings.workspaceEmpty);
        await page.getByRole('button', { name: t.onboarding.useDefaultWorkspace, exact: true }).click();
        await expect(workspaceNext).toBeEnabled();
        await workspaceNext.click();

        await expect(providerNext).toBeDisabled();
        await page.locator('#onboarding-provider-name').fill('   ');
        await page.locator('#onboarding-endpoint').fill('https://');
        await expect(providerNext).toBeDisabled();
        await modelsTab.click();
        await expect(page.locator('.field-error')).toHaveText([
          t.settings.providerNameEmpty, t.settings.endpointInvalid, t.settings.keyEmpty,
        ]);
        await page.locator('#onboarding-provider-name').fill('Fixture');
        await page.locator('#onboarding-endpoint').fill('https://api.example.com/v1');
        await expect(providerNext).toBeDisabled();
        await page.locator('#onboarding-endpoint-key').fill('fixture-key');
        await expect(providerNext).toBeEnabled();
        await page.locator('#onboarding-endpoint-key').fill(' ');
        await expect(providerNext).toBeDisabled();
        await page.locator('#onboarding-endpoint-key').fill('fixture-key');
        await expect(providerNext).toBeEnabled();
        await providerNext.click();

        await expect(modelsNext).toBeDisabled();
        await page.getByRole('button', { name: 'gpt-4o', exact: true }).click();
        await expect(modelsNext).toBeEnabled();
        await page.getByRole('button', { name: t.settings.modelsDeselectAll, exact: true }).click();
        await expect(modelsNext).toBeDisabled();
        await page.getByRole('button', { name: `← ${t.onboarding.prevStep}`, exact: true }).click();
        await expect(providerNext).toBeEnabled();
        await providerNext.click();
        await expect(modelsNext).toBeDisabled();
        await page.getByRole('button', { name: 'gpt-4o', exact: true }).click();
        await expect(modelsNext).toBeEnabled();
        await page.getByRole('button', { name: t.settings.modelsManualToggle, exact: true }).click();
        await page.locator('#endpoint-models').fill('custom-model');
        await expect(modelsNext).toBeDisabled();
        await page.locator('#onboarding-default-model').click();
        await page.getByRole('option', { name: 'custom-model', exact: true }).click();
        await expect(modelsNext).toBeEnabled();
        await modelsNext.click();

        await expect(createBot).toBeEnabled();
        await page.locator('#onboarding-bot-name').fill(' ');
        await expect(createBot).toBeDisabled();
        await page.locator('#onboarding-bot-duties').fill(' ');
        await page.locator('#onboarding-bot-boundaries').fill(' ');
        await page.locator('#onboarding-bot-name').fill('Fixture Bot');
        await expect(createBot).toBeDisabled();
        await page.locator('#onboarding-bot-duties').fill('Do the work');
        await expect(createBot).toBeDisabled();
        await page.locator('#onboarding-bot-boundaries').fill('Ask before deleting');
        await expect(createBot).toBeEnabled();
        await createBot.click();
        await expect(page.locator('.onboarding-screen')).toHaveCount(0);
        await expect(page.locator('.shell')).toBeVisible();
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  }
}
