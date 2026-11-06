import { chromium } from 'playwright';

export async function launch(headed = false) {
  return chromium.launch({
    headless: !headed,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    ...(process.env.TUTORIAL_EGRESS_PROXY
      ? { proxy: { server: process.env.TUTORIAL_EGRESS_PROXY } }
      : {}),
  });
}

export async function ready(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(async () => {
    await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))]);
  });
}
