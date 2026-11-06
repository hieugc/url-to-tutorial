/**
 * Always mask form fields before the first website paint. This script is
 * injected at document-start for each navigation, including same-origin
 * reloads. It is NOT a guarantee that arbitrary page text is private.
 */
export function privacyBoot({ selectors = [] } = {}) {
  const custom = Array.isArray(selectors) ? selectors : [];
  const hide = element => {
    if (!element || !element.style) return;
    if (element.matches('input,textarea,select,[contenteditable="true"]')) {
      // Keep controls actionable for an explicitly approved fill step, but
      // make all entered values invisible to browser capture and screenshots.
      element.style.setProperty('color', 'transparent', 'important');
      element.style.setProperty('text-shadow', 'none', 'important');
      element.style.setProperty('-webkit-text-security', 'disc', 'important');
    } else {
      element.style.setProperty('visibility', 'hidden', 'important');
    }
    element.setAttribute('data-tutorial-redacted', 'true');
  };
  const scan = () => {
    try {
      const elements = document.querySelectorAll(
        'input,textarea,select,[contenteditable="true"],[data-sensitive],[data-private],' +
        '[autocomplete="cc-number"],[autocomplete="one-time-code"]'
      );
      for (const el of elements) hide(el);
      for (const selector of custom) {
        for (const el of document.querySelectorAll(selector)) hide(el);
      }
    } catch (error) {
      window.__tutorialPrivacyError = 'Invalid redaction selector: ' + error.message;
    }
  };
  const style = document.createElement('style');
  style.textContent =
    'input,textarea,select,[contenteditable="true"],[data-sensitive],[data-private]' +
    '{color:transparent!important;text-shadow:none!important;-webkit-text-security:disc!important;}' +
    '[data-sensitive],[data-private]{visibility:hidden!important;}';
  const install = () => {
    if (!document.documentElement) return;
    document.documentElement.append(style);
    scan();
  };
  if (document.documentElement) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });

  // Avoid observing style changes: hide() itself must not recursively trigger
  // scans. Mutation observer covers dynamically inserted login/payment forms.
  const watcher = new MutationObserver(() => scan());
  const startObserver = () => {
    if (document.documentElement) watcher.observe(document.documentElement, {
      subtree: true, childList: true,
      attributes: true, attributeFilter: ['type', 'autocomplete', 'data-sensitive', 'data-private'],
    });
  };
  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
}

export async function installPrivacy(context, selectors = []) {
  if (!Array.isArray(selectors) || selectors.length > 20 || selectors.some(s =>
    typeof s !== 'string' || !s.trim() || s.length > 200)) {
    throw new Error('redactSelectors must contain at most 20 non-empty CSS selectors');
  }
  await context.addInitScript(privacyBoot, { selectors });
}

export async function assertSafeCapture(page) {
  const status = await page.evaluate(() => {
    if (window.__tutorialPrivacyError) return { error: window.__tutorialPrivacyError };
    const visible = el => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' &&
        (style.visibility !== 'hidden' || el.hasAttribute('data-tutorial-redacted')) &&
        rect.width > 0 && rect.height > 0;
    };
    const unsafe = [
      'iframe[src*="recaptcha"]', 'iframe[title*="captcha" i]',
      'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]', 'input[id*="otp" i]',
    ];
    for (const selector of unsafe) {
      if ([...document.querySelectorAll(selector)].some(visible)) {
        return { error: 'CAPTCHA/MFA/OTP challenge requires manual handling; automatic capture stopped' };
      }
    }
    return { error: null };
  });
  if (status.error) throw new Error(status.error);
}
