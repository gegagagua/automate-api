import { chromium } from "playwright";
import {
  GRID_INTERPRETATION_HINTS_GEO,
  waitForBalanceGridData,
} from "./balanceGridExtract.js";
import { balanceSessionLogout, runBalancePerRowAutomation } from "./balanceGridAutomation.js";
import { summarizeRowOutcomes } from "./balanceRowRules.js";

const DEFAULT_ACCOUNT_CODE = process.env.BALANCE_ACCOUNT_CODE ?? "1210.01";
const COMPANY_OPEN_TIMEOUT = 60000;
const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

const escapeForTextSelector = (value) => String(value).replace(/"/g, '\\"');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const dismissInterruptingDialogs = async (page) => {
  const cancelLocators = [
    page.getByRole("button", { name: "გაუქმება" }).first(),
    page.locator('button:has-text("გაუქმება")').first(),
    page.getByText("გაუქმება", { exact: true }).first(),
  ];

  for (const locator of cancelLocators) {
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible())) {
        await locator.click({ timeout: 1000 });
        await page.waitForTimeout(500);
        break;
      }
    } catch {
      // Ignore and try next selector.
    }
  }
};

const clickFirstVisible = async (locators, timeout = 5000) => {
  for (const locator of locators) {
    try {
      if ((await locator.count()) > 0) {
        const el = locator.first();
        await el.waitFor({ state: "visible", timeout: Math.min(timeout, 12000) }).catch(() => undefined);
        await el.scrollIntoViewIfNeeded();
        await el.click({ timeout });
        return true;
      }
    } catch {
      // try next
    }
  }
  return false;
};

const selectFirstBank = async (page) => {
  const bankInputCandidates = [
    page.locator('input[id*="Банк"]').first(),
    page.locator('input[name*="Банк"]').first(),
    page.locator('input[id*="Bank"]').first(),
    page.locator('input[name*="Bank"]').first(),
    page.locator('div:has-text("ბანკი:") input[type="text"]').first(),
  ];

  let bankInput = null;
  for (const locator of bankInputCandidates) {
    try {
      if ((await locator.count()) > 0) {
        bankInput = locator;
        break;
      }
    } catch {
      // Try next candidate.
    }
  }

  if (!bankInput) {
    throw new Error('Could not find "ბანკი" input');
  }

  await bankInput.click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);

  // Try keyboard-first selection (first available option).
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);

  // Fallback: if dropdown list is visible, click first row.
  const firstOptionCandidates = [
    page.locator('[role="option"]').first(),
    page.locator(".x-boundlist-item").first(),
    page.locator(".x-grid-item").first(),
  ];
  await clickFirstVisible(firstOptionCandidates, 1200);
};

const selectCompanyAccountFromCombobox = async (companyPage, accountCode) => {
  const code = String(accountCode || DEFAULT_ACCOUNT_CODE);
  const accountField = companyPage.locator("#form4_СчетКомпании_i0");
  await accountField.click();
  await companyPage.waitForTimeout(400);
  await companyPage.keyboard.press("Control+a");
  await companyPage.keyboard.press("Backspace");
  await companyPage.waitForTimeout(300);
  await companyPage.keyboard.type(code, { delay: 90 });
  await companyPage.waitForTimeout(1200);

  const codeRe = new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const listItemCandidates = [
    companyPage.locator(".x-boundlist-item").filter({ hasText: code }).first(),
    companyPage.locator("li.x-boundlist-item").filter({ hasText: code }).first(),
    companyPage.getByRole("option", { name: codeRe }).first(),
  ];
  const picked = await clickFirstVisible(listItemCandidates, 2800);
  if (!picked) {
    await companyPage.keyboard.press("Enter");
    await companyPage.waitForTimeout(1800);
  }
};

const detectRowsInFrame = async (frame) => {
  try {
    return await frame.evaluate(() => {
      const rowSelectors = [
        "tbody tr.x-grid-row",
        "tr.x-grid-row",
        ".x-grid-item-container > .x-grid-item",
        ".x-grid-item-container .x-grid-item",
        "div.x-grid-item",
        ".x-grid-item",
        ".x-grid-row",
        "div.x-grid-row",
        "table.x-grid-table tr",
        "tbody tr",
        "[data-recordid]",
      ];
      const containerSelectors = [
        ".x-grid-view",
        ".x-grid-item-container",
        ".x-grid-view-ct",
        ".x-panel-body",
        ".x-grid-body",
        "table",
      ];

      let visibleRowCount = 0;
      for (const selector of rowSelectors) {
        const rows = Array.from(document.querySelectorAll(selector));
        const visibleRows = rows.filter((row) => {
          const rect = row.getBoundingClientRect();
          if (rect.height <= 0 || rect.width <= 0) {
            return false;
          }
          if (
            row.closest?.(".x-grid-header") ||
            row.classList?.contains?.("x-grid-header-row") ||
            row.getAttribute?.("role") === "columnheader"
          ) {
            return false;
          }
          return true;
        });
        if (visibleRows.length > 0) {
          visibleRowCount = visibleRows.length;
          break;
        }
      }

      const hasScrollableContainer = containerSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some((el) => {
          const rect = el.getBoundingClientRect();
          return rect.height > 120 && rect.width > 300 && el.scrollHeight > el.clientHeight + 20;
        }),
      );

      return {
        visibleRowCount,
        hasScrollableContainer,
      };
    });
  } catch {
    return {
      visibleRowCount: 0,
      hasScrollableContainer: false,
    };
  }
};

const findBestGridFrame = async (page) => {
  const frames = [page.mainFrame(), ...page.frames()];
  let bestFrame = page.mainFrame();
  let bestScore = -1;

  for (const frame of frames) {
    const info = await detectRowsInFrame(frame);
    const score = info.visibleRowCount > 0 ? info.visibleRowCount + 1000 : info.hasScrollableContainer ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      bestFrame = frame;
    }
  }

  return bestFrame;
};

const waitForGeneratedRows = async (page, timeoutMs = 90000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const bestFrame = await findBestGridFrame(page);
    const info = await detectRowsInFrame(bestFrame);
    const detection = {
      hasRows: info.visibleRowCount > 0,
      hasScrollableContainer: info.hasScrollableContainer,
      frame: bestFrame,
    };

    if (detection.hasRows || detection.hasScrollableContainer) {
      return detection;
    }
    await page.waitForTimeout(1000);
  }

  return { hasRows: false, hasScrollableContainer: false };
};

const analyzeGeneratedRows = async (page, preferredFrame = null) => {
  const gridFrame = preferredFrame ?? (await findBestGridFrame(page));
  const rowsByKey = new Map();
  let scrollPasses = 0;
  let previousTopSignature = "";
  let stuckPasses = 0;

  for (let pass = 0; pass < 140; pass += 1) {
    const batch = await gridFrame.evaluate(() => {
      const rowSelectors = [
        "tbody tr.x-grid-row",
        "tr.x-grid-row",
        ".x-grid-item-container > .x-grid-item",
        ".x-grid-item-container .x-grid-item",
        "div.x-grid-item",
        ".x-grid-item",
        ".x-grid-row",
        "div.x-grid-row",
        "table.x-grid-table tr",
        "tbody tr",
        "[data-recordid]",
      ];
      const scrollSelectors = [
        ".x-grid-view",
        ".x-grid-item-container",
        ".x-grid-view-ct",
        ".x-panel-body",
        ".x-grid-body",
      ];

      const classifyCircleState = (signature) => {
        const value = String(signature || "").toLowerCase();
        if (!value) {
          return "unknown";
        }
        if (/(radial-gradient|linear-gradient|gradient|semi|half|partial|50%|ნახევ)/.test(value)) {
          return "halfGreen";
        }
        if (/(half|semi|partial|ნახევ|50%)/.test(value)) {
          return "halfGreen";
        }
        if (
          /(empty|blank|hollow|outline|unselected|uncheck|unchecked|radio-off|none|white-circle)/.test(
            value,
          )
        ) {
          return "empty";
        }
        if (/(green|success|ok|done|check-circle|complete|filled|status-ok|icon-ok)/.test(value)) {
          return "greenCircle";
        }
        return "unknown";
      };

      const getSignature = (el) => {
        if (!el) {
          return "";
        }
        const icon = el.querySelector("img, i, svg, span, div") || el;
        const style = window.getComputedStyle(icon);
        const chunks = [
          icon.tagName,
          icon.className || "",
          icon.getAttribute?.("title") || "",
          icon.getAttribute?.("aria-label") || "",
          icon.getAttribute?.("src") || "",
          icon.getAttribute?.("style") || "",
          style?.color || "",
          style?.backgroundColor || "",
          style?.backgroundImage || "",
          style?.maskImage || "",
          el.innerHTML || "",
        ];
        return chunks.join(" | ");
      };

      let rows = [];
      for (const selector of rowSelectors) {
        rows = Array.from(document.querySelectorAll(selector)).filter((row) => {
          const rect = row.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return false;
          }
          if (
            row.closest?.(".x-grid-header") ||
            row.classList?.contains?.("x-grid-header-row") ||
            row.getAttribute?.("role") === "columnheader"
          ) {
            return false;
          }
          return true;
        });
        if (rows.length > 0) {
          break;
        }
      }

      const cellQuery =
        "td, .x-grid-cell, .x-grid-cell-inner, .x-grid-td, .x-grid-rowbody, [class*=\"grid-cell\"]";

      const parsedRows = rows
        .map((row, rowIndex) => {
          let cells = Array.from(row.querySelectorAll(cellQuery)).filter((c) => {
            const rect = c.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (cells.length === 0) {
            const t = String(row.textContent || "")
              .replace(/\s+/g, " ")
              .trim();
            if (t.length < 3) {
              return null;
            }
            cells = [row];
          }
          if (cells.length < 1) {
            return null;
          }
          const cellTexts = cells
            .map((cell) => (cell.textContent || "").trim())
            .filter((text) => text.length > 0);
          if (cellTexts.length === 0) {
            return null;
          }
          const numericTexts = cellTexts.filter((value) => /^\d+$/.test(value));
          const firstNumeric = numericTexts[0] || "";
          const idText = firstNumeric || row.getAttribute("data-recordid") || row.getAttribute("data-id") || "";
          const fallbackText = cellTexts.slice(0, 3).join("|");

          const checkboxChecked =
            row.querySelector('input[type="checkbox"]:checked') !== null ||
            row.querySelector(".x-grid-checkcolumn-checked") !== null ||
            row.querySelector('[aria-checked="true"]') !== null ||
            /checkcolumn-checked|checkbox-checked|\bchecked\b/i.test(row.innerHTML) ||
            cells.some((cell) => /✓|✔/.test((cell.textContent || "").trim()));

          const firstCell = cells[0] || null;
          const iconSignature = getSignature(firstCell);
          const circleState = classifyCircleState(iconSignature);

          return {
            key: idText ? `id:${idText}` : `row:${rowIndex}:${fallbackText}`,
            rowId: idText || null,
            checked: checkboxChecked,
            circleState,
          };
        })
        .filter(Boolean)
        .filter((item) => item.key && item.key.length > 0);

      let scrollContainer = null;
      const firstRowEl = rows[0] || null;
      if (firstRowEl) {
        let ancestor = firstRowEl.parentElement;
        while (ancestor) {
          if (ancestor.scrollHeight > ancestor.clientHeight + 20) {
            const rect = ancestor.getBoundingClientRect();
            if (rect.height > 120 && rect.width > 300) {
              scrollContainer = ancestor;
              break;
            }
          }
          ancestor = ancestor.parentElement;
        }
      }

      for (const selector of scrollSelectors) {
        if (scrollContainer) {
          break;
        }
        const candidates = Array.from(document.querySelectorAll(selector));
        scrollContainer = candidates.find(
          (el) =>
            el.scrollHeight - el.clientHeight > 20 &&
            el.getBoundingClientRect().height > 120 &&
            el.getBoundingClientRect().width > 300,
        );
        if (scrollContainer) {
          break;
        }
      }

      if (!scrollContainer) {
        scrollContainer = document.scrollingElement || document.documentElement;
      }

      const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      const currentTop = scrollContainer.scrollTop;
      const step = Math.max(260, Math.floor(scrollContainer.clientHeight * 0.9));
      const nextTop = Math.min(maxScrollTop, currentTop + step);
      const canMove = nextTop > currentTop + 1;
      if (canMove) {
        scrollContainer.scrollTop = nextTop;
        scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
      }

      const topKey = parsedRows[0]?.key || "";

      return {
        parsedRows,
        moved: canMove,
        atBottom: maxScrollTop - nextTop <= 1,
        topKey,
      };
    });

    for (const row of batch.parsedRows) {
      const existing = rowsByKey.get(row.key);
      if (!existing) {
        rowsByKey.set(row.key, row);
        continue;
      }
      rowsByKey.set(row.key, {
        ...existing,
        checked: existing.checked || row.checked,
        circleState: existing.circleState !== "unknown" ? existing.circleState : row.circleState,
        rowId: existing.rowId || row.rowId,
      });
    }

    scrollPasses = pass + 1;
    if (batch.topKey && batch.topKey === previousTopSignature) {
      stuckPasses += 1;
    } else {
      stuckPasses = 0;
      previousTopSignature = batch.topKey || previousTopSignature;
    }

    if (!batch.moved || batch.atBottom || stuckPasses >= 4) {
      break;
    }
    await page.waitForTimeout(450);
  }

  const entries = Array.from(rowsByKey.values());
  const toUniqueSortedIds = (source) =>
    Array.from(new Set(source.filter(Boolean)))
      .map((value) => String(value))
      .sort((a, b) => Number(a) - Number(b));

  const checkedIds = toUniqueSortedIds(entries.filter((row) => row.checked).map((row) => row.rowId));
  const greenCircleIds = toUniqueSortedIds(
    entries.filter((row) => row.circleState === "greenCircle").map((row) => row.rowId),
  );
  const emptyCircleIds = toUniqueSortedIds(
    entries.filter((row) => row.circleState === "empty").map((row) => row.rowId),
  );
  const halfGreenCircleIds = toUniqueSortedIds(
    entries.filter((row) => row.circleState === "halfGreen").map((row) => row.rowId),
  );
  const unknownCircleIds = toUniqueSortedIds(
    entries.filter((row) => row.circleState === "unknown").map((row) => row.rowId),
  );

  return {
    totalRowsSeen: entries.length,
    scrollPasses,
    frameUrl: gridFrame.url(),
    checked: { count: checkedIds.length, ids: checkedIds },
    greenCircle: { count: greenCircleIds.length, ids: greenCircleIds },
    emptyCircle: { count: emptyCircleIds.length, ids: emptyCircleIds },
    halfGreenCircle: { count: halfGreenCircleIds.length, ids: halfGreenCircleIds },
    unknownCircle: { count: unknownCircleIds.length, ids: unknownCircleIds },
  };
};

const captureFrame = async (page, label, onScreenshot) => {
  if (!onScreenshot) return;
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
    onScreenshot({ frame: buf.toString("base64"), label });
  } catch {
    // ignore screenshot capture errors
  }
};

export const runBalanceWorkflow = async ({
  loginEmail,
  loginPassword,
  companyName,
  filePath,
  accountCode = DEFAULT_ACCOUNT_CODE,
  successScreenshotPath,
  failureScreenshotPath,
  headless = process.env.PLAYWRIGHT_HEADLESS !== "false",
  slowMo = Number(process.env.PLAYWRIGHT_SLOW_MO ?? 800),
  onScreenshot = null,
  onStep = null,
}) => {
  const browser = await chromium.launch({
    headless,
    slowMo: Number.isNaN(slowMo) ? 800 : slowMo,
    args: [
      "--disable-blink-features=AutomationControlled",
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
    ],
  });

  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    screen: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => false });");
  let currentPage = page;

  const steps = [];
  const markStep = (step) => {
    steps.push(step);
    try { onStep?.({ step }); } catch { /* ignore */ }
  };

  const activePageRef = { current: page };

  let screenshotTimer = null;
  if (onScreenshot) {
    screenshotTimer = setInterval(async () => {
      await captureFrame(activePageRef.current, "periodic", onScreenshot).catch(() => {});
    }, 5000);
  }

  try {
    markStep("open-balance-home");
    await page.goto("https://www.balance.ge", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    markStep("open-login-page");
    await page.click('a[href*="/login"]');
    await page.waitForTimeout(3000);
    await dismissInterruptingDialogs(page);

    markStep("fill-credentials");
    await page.fill('input[name="Email"]', loginEmail);
    await page.fill('input[name="Password"]', loginPassword);
    await page.waitForTimeout(500);

    markStep("submit-login");
    await page.click("button.dark_btn");
    await page.waitForTimeout(5000);
    await dismissInterruptingDialogs(page);
    await captureFrame(page, "after-login", onScreenshot);

    markStep("open-company-window");
    const name = String(companyName || "").trim();
    if (!name) {
      throw new Error("companyName is required to open the company card");
    }

    markStep("select-mydatabase-company-card");
    const myDatabaseScope = page
      .locator("div, section, article")
      .filter({ has: page.getByText(/MyDatabases?/i) })
      .filter({ has: page.getByText(name, { exact: true }) })
      .first();

    const nameRe = new RegExp(escapeRegex(name));
    const companyOpenLocators = [
      myDatabaseScope.getByRole("button", { name: nameRe }),
      myDatabaseScope.locator(`button:has-text("${escapeForTextSelector(name)}")`),
      myDatabaseScope.getByText(name, { exact: true }),
      page.getByRole("button", { name: nameRe }).first(),
      page.locator(`button:has-text("${escapeForTextSelector(name)}")`).first(),
      page.getByText(name, { exact: true }).first(),
      page.locator(`text="${escapeForTextSelector(name)}"`).first(),
    ];

    let clicked = false;
    let popupPage = null;
    for (const locator of companyOpenLocators) {
      try {
        if ((await locator.count()) === 0) {
          continue;
        }
        const target = locator.first();
        await target.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
        await target.scrollIntoViewIfNeeded().catch(() => undefined);
        const popupPromise = context.waitForEvent("page", { timeout: 7000 }).catch(() => null);
        await target.click({ timeout: 7000 });
        popupPage = await popupPromise;
        clicked = true;
        break;
      } catch {
        // try next locator
      }
    }

    if (!clicked) {
      throw new Error(
        `Could not find company card under MyDatabase (or by name). Company: ${companyName}`,
      );
    }

    const companyPage = popupPage ?? page;
    currentPage = companyPage;
    activePageRef.current = companyPage;

    await companyPage.waitForLoadState("domcontentloaded");
    await companyPage.waitForLoadState("networkidle").catch(() => undefined);
    await companyPage.waitForTimeout(4500);
    await dismissInterruptingDialogs(companyPage);
    await captureFrame(companyPage, "company-page-loaded", onScreenshot);

    markStep("go-to-cash-section");
    const cashCandidates = [
      companyPage.locator('a:has-text("ფულადი სახსრები")'),
      companyPage.locator('span:has-text("ფულადი სახსრები")'),
      companyPage.getByRole("link", { name: "ფულადი სახსრები" }),
      companyPage.getByRole("button", { name: "ფულადი სახსრები" }),
      companyPage.getByText("ფულადი სახსრები", { exact: false }),
      companyPage.locator('[title*="ფულადი სახსრები"]').first(),
    ];

    let clickedCash = false;
    for (let i = 0; i < 8; i += 1) {
      await dismissInterruptingDialogs(companyPage);
      await companyPage.waitForTimeout(700);
      clickedCash = await clickFirstVisible(cashCandidates, 12000);
      if (clickedCash) {
        break;
      }

      // Fallback: menu may require keyboard focus/navigation.
      await companyPage.keyboard.press("Escape").catch(() => undefined);
      await companyPage.keyboard.press("Home").catch(() => undefined);
      await companyPage.waitForTimeout(1300);
    }

    if (!clickedCash) {
      throw new Error('Could not click "ფულადი სახსრები" menu item');
    }

    await companyPage.waitForTimeout(7000);
    await captureFrame(companyPage, "cash-section-opened", onScreenshot);

    markStep("open-bank-upload-page");
    await companyPage.click('text="ბანკიდან ამონაწერის ჩატვირთვა"');
    await companyPage.waitForTimeout(5000);
    await dismissInterruptingDialogs(companyPage);
    await captureFrame(companyPage, "bank-upload-page", onScreenshot);

    markStep("select-bank-account-first");
    await selectFirstBank(companyPage);
    await companyPage.waitForTimeout(1400);

    markStep("select-company-account-dropdown");
    await selectCompanyAccountFromCombobox(companyPage, accountCode);
    await companyPage.waitForTimeout(1200);

    markStep("open-excel-dialog");
    await companyPage.locator('[title="ექსელიდან შევსება"]').click();
    await companyPage.waitForTimeout(3000);
    await dismissInterruptingDialogs(companyPage);

    markStep("choose-file");
    const fileChooserPromise = companyPage.waitForEvent("filechooser", { timeout: 15000 });
    try {
      await companyPage.click('text="select from disk"', { timeout: 3000 });
    } catch {
      try {
        await companyPage.click('text="Select from disk"', { timeout: 3000 });
      } catch {
        await companyPage.click('text="აირჩიე დისკიდან"', { timeout: 3000 });
      }
    }

    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(filePath);
    await companyPage.waitForTimeout(3000);

    markStep("confirm-upload");
    await companyPage.click('text="OK"');
    await companyPage.waitForTimeout(8000);
    await dismissInterruptingDialogs(companyPage);
    await captureFrame(companyPage, "after-upload-confirm", onScreenshot);

    markStep("wait-generated-list");
    const generatedListDetection = await waitForGeneratedRows(companyPage);
    await companyPage.waitForTimeout(2000);
    await captureFrame(companyPage, "generated-list", onScreenshot);

    const gridWaitMs = Number(process.env.BALANCE_GRID_WAIT_MS ?? 120000);
    markStep(`wait-balance-grid-data-${gridWaitMs}ms`);
    const gridData = await waitForBalanceGridData(companyPage, gridWaitMs);

    markStep("analyze-generated-list");
    let analytics = null;
    let analyticsWarning = "";
    try {
      analytics = await analyzeGeneratedRows(companyPage, gridData.frame);
      if (!generatedListDetection.hasRows && analytics.totalRowsSeen === 0) {
        analyticsWarning = "List was not detected reliably; analytics may be incomplete.";
      }
      if (gridData.extractedRowCount === 0) {
        analyticsWarning =
          `${analyticsWarning ? `${analyticsWarning} ` : ""}გრიდიდან 0 სტრიქონი (${gridData.waitedMs}ms ლოდინის შემდეგ). იხილე interpretationHints / gridExtraction.`;
      }
    } catch {
      analyticsWarning = "Could not fully analyze generated list.";
      analytics = {
        totalRowsSeen: 0,
        scrollPasses: 0,
        checked: { count: 0, ids: [] },
        greenCircle: { count: 0, ids: [] },
        emptyCircle: { count: 0, ids: [] },
        halfGreenCircle: { count: 0, ids: [] },
        unknownCircle: { count: 0, ids: [] },
      };
    }

    analytics = {
      ...analytics,
      gridExtraction: {
        extractedRowCount: gridData.extractedRowCount,
        waitOk: gridData.ok,
        waitedMs: gridData.waitedMs,
        frameUrl: typeof gridData.frame?.url === "function" ? gridData.frame.url() : "",
        interpretationHints: GRID_INTERPRETATION_HINTS_GEO,
      },
    };

    await captureFrame(companyPage, "before-per-row-automation", onScreenshot);
    markStep("per-row-balance-rules-and-ui");
    let rowOutcomes = [];
    let rowOutcomeSummary = {
      total: 0,
      skipped: 0,
      failed_rule: 0,
      document_created: 0,
      automation_failed: 0,
      pending_automation: 0,
      ready_for_document: 0,
      byMessage: {},
    };
    try {
      rowOutcomes = await runBalancePerRowAutomation(companyPage, gridData.frame, markStep, {
        skipLogout: true,
        gridDetection: {
          extractedRowCount: gridData.extractedRowCount,
          ok: gridData.ok,
          waitedMs: gridData.waitedMs,
          hints: GRID_INTERPRETATION_HINTS_GEO,
        },
      });
      rowOutcomeSummary = summarizeRowOutcomes(rowOutcomes);
    } catch (automationError) {
      markStep(
        `per-row-automation-fatal: ${automationError instanceof Error ? automationError.message : String(automationError)}`,
      );
      rowOutcomes = [];
      rowOutcomeSummary = summarizeRowOutcomes(rowOutcomes);
    }

    await captureFrame(currentPage, "after-per-row-automation", onScreenshot);

    if (successScreenshotPath) {
      await currentPage.screenshot({ path: successScreenshotPath, fullPage: true });
    }

    markStep("rule-step-13-logout");
    await balanceSessionLogout(companyPage);

    const fr = rowOutcomeSummary.failed_rule ?? 0;
    const rulesMessage = `Rows: total=${rowOutcomeSummary.total}, skipped=${rowOutcomeSummary.skipped}, failed_rule=${fr}, documents=${rowOutcomeSummary.document_created}, ui_failed=${rowOutcomeSummary.automation_failed}, pending=${rowOutcomeSummary.pending_automation}.`;
    const note = analyticsWarning ? ` ${analyticsWarning}` : "";

    return {
      ok: true,
      message: `Balance upload flow completed. ${rulesMessage}${note}`,
      steps,
      uploadedFile: filePath,
      analytics,
      rowOutcomes,
      rowOutcomeSummary,
    };
  } catch (error) {
    await captureFrame(currentPage, "on-error", onScreenshot).catch(() => undefined);
    if (failureScreenshotPath) {
      try {
        await currentPage.screenshot({ path: failureScreenshotPath, fullPage: true });
      } catch {
        // Ignore screenshot failure and bubble original error.
      }
    }

    const workflowError = new Error(error instanceof Error ? error.message : "Unknown workflow error");
    workflowError.steps = steps;
    throw workflowError;
  } finally {
    if (screenshotTimer) clearInterval(screenshotTimer);
    await context.close();
    await browser.close();
  }
};
