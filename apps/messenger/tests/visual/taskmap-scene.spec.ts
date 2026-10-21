import { expect, test, webkit, type Browser, type Page } from '@playwright/test';

type Sign = { selector: string; ratio: number };

/**
 * Every sign's words against the theme's pane, the colour the plates, badges and labels are made
 * of: computed colours, each resolved through a canvas (a color-mix() comes back as `color(srgb …)`),
 * so a near colour a screenshot diff would let pass still fails here.
 */
async function signs(page: Page): Promise<{ plate: number; signs: Sign[] }> {
  return page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const rgb = (css: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!];
    };
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const pane = lum(rgb(getComputedStyle(document.documentElement).getPropertyValue('--pane').trim()));
    const ratio = (css: string) => { const l = lum(rgb(css)); return (Math.max(l, pane) + 0.05) / (Math.min(l, pane) + 0.05); };
    const selectors = ['.tm-plate-label', '.tm-plate-n', '.tm-plate-line', '.tm-plate-model', '.tm-badge-name', '.tm-badge-model', '.tm-region'];
    const out: Sign[] = [];
    for (const selector of selectors) {
      const els = [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => el.textContent?.trim());
      if (!els.length) throw new Error(`no ${selector} on the map`);
      for (const el of els) out.push({ selector, ratio: ratio(getComputedStyle(el).color) });
    }
    const plate = lum(rgb(getComputedStyle(document.querySelector('.tm-plate')!).backgroundColor));
    return { plate, signs: out };
  });
}

async function followsTheTheme(page: Page, baseURL: string | undefined): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.goto(`${baseURL}index.html?story=taskmap-scene&theme=${theme}`);
    await expect(page.locator('.tm-plate-line').first()).toBeVisible({ timeout: 5000 });
    const read = await signs(page);
    // The plate is the theme's own surface: near white in light, near black in dark.
    if (theme === 'light') expect(read.plate).toBeGreaterThan(0.8);
    else expect(read.plate).toBeLessThan(0.05);
    // Each line of words, a character's coloured name among them, reads on it at 4.5:1 or better.
    for (const sign of read.signs) expect(sign.ratio, `${theme} ${sign.selector}`).toBeGreaterThanOrEqual(4.5);
  }
}

test('the task map signs follow the theme and their words read on them', async ({ page, baseURL }) => {
  await followsTheTheme(page, baseURL);
});

test('webkit: the task map signs follow the theme the same way', async ({ baseURL }) => {
  let browser: Browser | null = null;
  try {
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await followsTheTheme(page, baseURL);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
  }
});
