import fs from "node:fs";
import path from "node:path";
import { addExtra } from "playwright-extra";
import { chromium as baseChromium } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const chromium = addExtra(baseChromium);
chromium.use(StealthPlugin());

export const BALANCE_VIEWPORT = { width: 1440, height: 900 };

const BALANCE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const allowedPlaywrightChannels = new Set(["chrome", "msedge", "chromium", "chrome-beta"]);

export const createBalanceAutomationBrowser = async ({ headless, slowMo }) => {
  const sm = Number(slowMo);
  const effectiveSlowMo = Number.isNaN(sm) ? Number(process.env.PLAYWRIGHT_SLOW_MO ?? 800) : sm;
  const channelRaw = process.env.PLAYWRIGHT_CHANNEL?.trim();
  const channel = channelRaw && allowedPlaywrightChannels.has(channelRaw) ? channelRaw : undefined;

  const storageStatePath = process.env.PLAYWRIGHT_STORAGE_STATE?.trim();
  const resolvedStorage =
    storageStatePath && fs.existsSync(path.resolve(storageStatePath))
      ? path.resolve(storageStatePath)
      : undefined;

  const browser = await chromium.launch({
    headless,
    slowMo: Number.isNaN(effectiveSlowMo) ? 0 : effectiveSlowMo,
    channel,
    args: [
      "--disable-blink-features=AutomationControlled",
      `--window-size=${BALANCE_VIEWPORT.width},${BALANCE_VIEWPORT.height}`,
    ],
  });

  const contextOptions = {
    viewport: BALANCE_VIEWPORT,
    screen: { width: BALANCE_VIEWPORT.width, height: BALANCE_VIEWPORT.height },
    userAgent: BALANCE_USER_AGENT,
    locale: "en-US",
    timezoneId: "America/New_York",
  };
  if (resolvedStorage) {
    contextOptions.storageState = resolvedStorage;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  return { browser, context, page };
};

export const launchBrowser = async () => {
  const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
  const slowMo = Number(process.env.PLAYWRIGHT_SLOW_MO ?? 0);

  return chromium.launch({
    headless,
    slowMo: Number.isNaN(slowMo) ? 0 : slowMo,
  });
};

export const withPage = async (task) => {
  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    return await task(page, context, browser);
  } finally {
    await context.close();
    await browser.close();
  }
};
