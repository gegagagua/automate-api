import { chromium } from "playwright";

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
