import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const EMAIL = "kavelashvili.irakli@gmail.com";
const PASSWORD = "Test123!@#";

const run = async () => {
  const browser = await chromium.launch({
    headless: true,
    slowMo: 500,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--window-size=1440,900",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    screen: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "ka-GE",
    timezoneId: "Asia/Tbilisi",
  });

  const page = await context.newPage();

  try {
    console.log("1. www.balance.ge homepage...");
    await page.goto("https://www.balance.ge", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const homeTitle = await page.title();
    console.log("   Title:", homeTitle);

    if (homeTitle.includes("moment")) {
      console.log("   ⚠ Homepage-ზეც CF challenge ჩნდება");
      await page.waitForTimeout(10000);
      const t = await page.title();
      console.log("   10s შემდეგ:", t);
    }

    console.log("2. Login ლინკზე კლიკი...");
    await page.click('a[href*="/login"]');
    await page.waitForTimeout(4000);

    let attempts = 0;
    while (attempts < 6) {
      const t = await page.title();
      const u = page.url();
      console.log(`   [${attempts + 1}] "${t}" | ${u}`);
      if (!t.includes("moment") && !t.includes("Cloudflare")) break;
      await page.waitForTimeout(4000);
      attempts++;
    }

    await page.screenshot({ path: "/tmp/step2-login.png" });

    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input")).map((el) => ({
        type: el.type, name: el.name, id: el.id,
      }))
    );
    console.log("   Inputs:", inputs);

    const emailInput = page.locator("#Email, input[name='Email']");
    if ((await emailInput.count()) === 0) {
      console.log("   ✗ Login form ჯერ კიდევ CF-ის უკან");
      return;
    }

    console.log("3. Credentials...");
    await emailInput.fill(EMAIL);
    await page.locator("#Password, input[name='Password']").fill(PASSWORD);
    await page.waitForTimeout(800);
    await page.screenshot({ path: "/tmp/step3-filled.png" });

    console.log("4. Submit...");
    const [nav] = await Promise.all([
      page.waitForNavigation({ timeout: 25000, waitUntil: "domcontentloaded" }).catch(() => null),
      page.click("button.dark_btn"),
    ]);

    let postAttempts = 0;
    while (postAttempts < 8) {
      const t = await page.title();
      const u = page.url();
      console.log(`   [post-${postAttempts + 1}] "${t}" | ${u}`);
      if (!t.includes("moment") && !t.includes("Cloudflare")) break;
      await page.waitForTimeout(4000);
      postAttempts++;
    }

    const urlAfter = page.url();
    const titleAfter = await page.title();
    await page.screenshot({ path: "/tmp/step4-result.png" });

    console.log("\n=== შედეგი ===");
    if (!urlAfter.includes("/login")) {
      console.log("✓ წარმატებული LOGIN! URL:", urlAfter);
    } else if (titleAfter.includes("moment")) {
      console.log("✗ Cloudflare ბლოკავს POST /login ამ IP-დან");
      console.log("  → სერვერის IP Cloudflare-ის datacenter სიაშია");
    } else {
      const bodyText = await page.locator("body").textContent().catch(() => "");
      const errMatch = bodyText?.match(/.{0,100}(invalid|incorrect|არასწორი|შეცდომა).{0,100}/i);
      if (errMatch) console.log("✗ Login error:", errMatch[0].trim());
      else console.log("✗ Login-ზე დარჩა, body:", bodyText?.substring(0, 200));
    }

  } catch (err) {
    console.error("✗ Exception:", err.message);
    await page.screenshot({ path: "/tmp/login-exception.png" }).catch(() => {});
  } finally {
    await context.close();
    await browser.close();
  }
};

run().catch((err) => { console.error("Fatal:", err); process.exit(1); });
