import { withPage } from "./browser.js";

const run = async () => {
  const result = await withPage(async (page) => {
    await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
    return {
      title: await page.title(),
      url: page.url(),
    };
  });

  console.log("Playwright is ready:", result);
};

run().catch((error) => {
  console.error("Playwright smoke failed:", error);
  process.exit(1);
});
