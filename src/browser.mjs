import { chromium } from 'playwright';

export async function launch(headed = false) {
  return chromium.launch({ headless: !headed,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
}

export async function ready(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(async () => {
    await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))]);
  });
}
