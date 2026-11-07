import { chromium } from 'playwright';

export async function launch(headed = false) {
  return chromium.launch({
    headless: !headed,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    ...(process.env.TUTORIAL_EGRESS_PROXY
      ? {
        proxy: { server: process.env.TUTORIAL_EGRESS_PROXY, bypass: '<-loopback>' },
        // HTTP CONNECT is the only supported cloud egress path. Disable QUIC
        // so Chromium cannot prefer a direct UDP/HTTP3 route around the proxy.
        args: ['--disable-quic'],
      }
      : {}),
  });
}

export async function ready(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(async () => {
    await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))]);
  });
}
