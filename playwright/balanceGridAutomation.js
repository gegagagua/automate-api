import { extractBalanceGridRows, getColumnIndicesByKey } from "./balanceGridExtract.js";
import { evaluateBalanceRow, evaluateBalanceRows, getRowUiPlan } from "./balanceRowRules.js";

const LOADING_VALUE = "მომწოდებლისთვის თანხის გადახდა";
const CORR_VALUE = "3110.01";

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getGridInteractionMeta = (colMap, rowSnapshot) => ({
  gridKind: colMap.gridKind ?? "ext",
  stableRowKey: rowSnapshot?.stableRowKey != null ? String(rowSnapshot.stableRowKey) : "",
});

const clickOneCGridBox = async (frame, rowIndex, colindex, stableRowKey, dblclick) => {
  const page = frame.page();
  const ok = await frame.evaluate(
    ({ ri, colindex: ci, stableKey, dbl }) => {
      const isVisibleEl = (el) => {
        if (!el) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const lines = Array.from(document.querySelectorAll(".gridBody .gridLine")).filter(isVisibleEl);
      lines.sort(
        (a, b) =>
          Number(a.getAttribute("rowindex") ?? 0) - Number(b.getAttribute("rowindex") ?? 0),
      );
      let line =
        stableKey && String(stableKey).length > 0
          ? document.querySelector(`.gridBody .gridLine[rowindex="${stableKey}"]`)
          : lines[ri];
      if (!line) {
        return false;
      }
      line.scrollIntoView({ block: "center", behavior: "instant" });
      const box = line.querySelector(`.gridBox[colindex="${String(ci)}"]`);
      if (!box) {
        return false;
      }
      const target = box.querySelector(".gridBoxText") || box.querySelector(".gridBoxTitle") || box;
      target.dispatchEvent(
        new MouseEvent(dbl ? "dblclick" : "click", { bubbles: true, cancelable: true, view: window }),
      );
      return true;
    },
    { ri: rowIndex, colindex, stableKey: stableRowKey || "", dbl: Boolean(dblclick) },
  );
  if (!ok) {
    throw new Error(`1c grid ${dblclick ? "dblclick" : "click"} failed row=${rowIndex} colindex=${colindex}`);
  }
  await page.waitForTimeout(dblclick ? 450 : 280);
};

const dismissDialogs = async (page) => {
  const locators = [
    page.getByRole("button", { name: "გაუქმება" }).first(),
    page.locator('button:has-text("გაუქმება")').first(),
  ];
  for (const loc of locators) {
    try {
      if ((await loc.count()) > 0 && (await loc.first().isVisible())) {
        await loc.first().click({ timeout: 1200 });
        await page.waitForTimeout(400);
        break;
      }
    } catch {
      // Ignore.
    }
  }
};

const clickGridCell = async (frame, rowIndex, colIndex, meta) => {
  if (meta?.gridKind === "1c" && colIndex !== undefined) {
    await clickOneCGridBox(frame, rowIndex, colIndex, meta.stableRowKey, false);
    return;
  }
  const page = frame.page();
  const ok = await frame.evaluate(
    ({ ri, ci }) => {
      const isVisibleEl = (el) => {
        if (!el) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const rows = (() => {
        const tryLists = [
          () => Array.from(document.querySelectorAll("tbody tr.x-grid-row")).filter(isVisibleEl),
          () =>
            Array.from(document.querySelectorAll("tr.x-grid-row")).filter(
              (tr) =>
                isVisibleEl(tr) &&
                !tr.closest(".x-grid-header") &&
                !tr.classList.contains("x-grid-header-row"),
            ),
          () => Array.from(document.querySelectorAll(".x-grid-item")).filter(isVisibleEl),
        ];
        for (const fn of tryLists) {
          const r = fn();
          if (r.length > ri) {
            return r;
          }
        }
        return [];
      })();
      const row = rows[ri];
      if (!row) {
        return false;
      }
      const cells = Array.from(row.querySelectorAll("td, .x-grid-cell")).filter(isVisibleEl);
      const cell = cells[ci];
      if (!cell) {
        return false;
      }
      cell.scrollIntoView({ block: "center", behavior: "instant" });
      cell.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    },
    { ri: rowIndex, ci: colIndex },
  );
  if (!ok) {
    throw new Error(`click cell failed row=${rowIndex} col=${colIndex}`);
  }
  await page.waitForTimeout(280);
};

const dblClickGridCell = async (frame, rowIndex, colIndex, meta) => {
  if (meta?.gridKind === "1c" && colIndex !== undefined) {
    await clickOneCGridBox(frame, rowIndex, colIndex, meta.stableRowKey, true);
    return;
  }
  const page = frame.page();
  const ok = await frame.evaluate(
    ({ ri, ci }) => {
      const isVisibleEl = (el) => {
        if (!el) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const rows = (() => {
        const tryLists = [
          () => Array.from(document.querySelectorAll("tbody tr.x-grid-row")).filter(isVisibleEl),
          () =>
            Array.from(document.querySelectorAll("tr.x-grid-row")).filter(
              (tr) =>
                isVisibleEl(tr) &&
                !tr.closest(".x-grid-header") &&
                !tr.classList.contains("x-grid-header-row"),
            ),
          () => Array.from(document.querySelectorAll(".x-grid-item")).filter(isVisibleEl),
        ];
        for (const fn of tryLists) {
          const r = fn();
          if (r.length > ri) {
            return r;
          }
        }
        return [];
      })();
      const row = rows[ri];
      if (!row) {
        return false;
      }
      const cells = Array.from(row.querySelectorAll("td, .x-grid-cell")).filter(isVisibleEl);
      const cell = cells[ci];
      if (!cell) {
        return false;
      }
      cell.scrollIntoView({ block: "center", behavior: "instant" });
      cell.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }),
      );
      return true;
    },
    { ri: rowIndex, ci: colIndex },
  );
  if (!ok) {
    throw new Error(`dblclick cell failed row=${rowIndex} col=${colIndex}`);
  }
  await page.waitForTimeout(450);
};

const clickRowCheckbox = async (frame, rowIndex, meta) => {
  const page = frame.page();
  if (meta?.gridKind === "1c") {
    const ok = await frame.evaluate(
      ({ ri, stableKey }) => {
        const isVisibleEl = (el) => {
          if (!el) {
            return false;
          }
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const lines = Array.from(document.querySelectorAll(".gridBody .gridLine")).filter(isVisibleEl);
        lines.sort(
          (a, b) =>
            Number(a.getAttribute("rowindex") ?? 0) - Number(b.getAttribute("rowindex") ?? 0),
        );
        let line =
          stableKey && String(stableKey).length > 0
            ? document.querySelector(`.gridBody .gridLine[rowindex="${stableKey}"]`)
            : lines[ri];
        if (!line) {
          return false;
        }
        line.scrollIntoView({ block: "center", behavior: "instant" });
        const cb =
          line.querySelector(".checkbox") ||
          line.querySelector('input[type="checkbox"]');
        if (cb) {
          cb.click();
          return true;
        }
        return false;
      },
      { ri: rowIndex, stableKey: meta.stableRowKey || "" },
    );
    if (!ok) {
      throw new Error(`1c checkbox row=${rowIndex}`);
    }
    await page.waitForTimeout(350);
    return;
  }
  const ok = await frame.evaluate(({ ri }) => {
    const isVisibleEl = (el) => {
      if (!el) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const rows = (() => {
      const tryLists = [
        () => Array.from(document.querySelectorAll("tbody tr.x-grid-row")).filter(isVisibleEl),
        () =>
          Array.from(document.querySelectorAll("tr.x-grid-row")).filter(
            (tr) =>
              isVisibleEl(tr) &&
              !tr.closest(".x-grid-header") &&
              !tr.classList.contains("x-grid-header-row"),
          ),
        () => Array.from(document.querySelectorAll(".x-grid-item")).filter(isVisibleEl),
      ];
      for (const fn of tryLists) {
        const r = fn();
        if (r.length > ri) {
          return r;
        }
      }
      return [];
    })();
    const row = rows[ri];
    if (!row) {
      return false;
    }
    row.scrollIntoView({ block: "center", behavior: "instant" });
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb) {
      cb.click();
      return true;
    }
    const cells = Array.from(row.querySelectorAll("td, .x-grid-cell")).filter(isVisibleEl);
    if (cells[0]) {
      cells[0].click();
      return true;
    }
    return false;
  }, { ri: rowIndex });
  if (!ok) {
    throw new Error(`checkbox row=${rowIndex}`);
  }
  await page.waitForTimeout(350);
};

const findMatchingRowIndex = (rows, snapRow) => {
  if (snapRow.stableRowKey != null && String(snapRow.stableRowKey).length > 0) {
    const byStable = rows.findIndex((r) => String(r.stableRowKey) === String(snapRow.stableRowKey));
    if (byStable >= 0) {
      return byStable;
    }
  }
  const j = String(snapRow.rawJoined || "").trim();
  const p = String(snapRow.purpose || "").trim();
  if (j.length > 0) {
    const byJoin = rows.findIndex((r) => String(r.rawJoined || "").trim() === j);
    if (byJoin >= 0) {
      return byJoin;
    }
  }
  if (p.length > 0) {
    const byPurpose = rows.findIndex((r) => String(r.purpose || "").trim() === p);
    if (byPurpose >= 0) {
      return byPurpose;
    }
  }
  if (p.length > 12) {
    const slice = p.slice(0, 60);
    return rows.findIndex((r) => String(r.rawJoined || "").includes(slice));
  }
  return -1;
};

const tryApplyGlobalMccFilter = async (page, frame) => {
  try {
    const hdr = frame.locator(".x-column-header").filter({ hasText: "დანიშნულება" }).first();
    if ((await hdr.count()) === 0) {
      return;
    }
    const trigger = hdr.locator(".x-column-header-trigger").first();
    if ((await trigger.count()) > 0) {
      await trigger.click({ timeout: 2500 });
    } else {
      await hdr.click({ timeout: 2500 });
    }
    await page.waitForTimeout(400);
    const searchBtn = page.getByRole("button", { name: /Search|ძებნა/i }).first();
    if ((await searchBtn.count()) > 0) {
      await searchBtn.click({ timeout: 2000 }).catch(() => undefined);
    }
    await page.waitForTimeout(300);
    await page.keyboard.type("MCC", { delay: 45 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
  } catch {
    // Filter UI may differ; continue per-row.
  }
};

const runStep5PurposeMcc = async (page, frame, rowIndex, purposeCol, meta) => {
  if (purposeCol === undefined) {
    return;
  }
  await dismissDialogs(page);
  await clickGridCell(frame, rowIndex, purposeCol, meta);
  await page.waitForTimeout(200);
  const searchBtn = page.getByRole("button", { name: /Search|ძებნა/i }).first();
  if ((await searchBtn.count()) > 0) {
    await searchBtn.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await page.keyboard.press("Control+a").catch(() => undefined);
  await page.keyboard.type("MCC", { delay: 40 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
};

const pickBoundlistForValue = async (page, value) => {
  const chunk = String(value || "").slice(0, 48);
  if (!chunk) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    return;
  }
  const re = new RegExp(escapeRegex(chunk), "i");
  const match = page.locator(".x-boundlist-item").filter({ hasText: re });
  const n = await match.count();
  if (n > 1) {
    await match.first().click({ timeout: 4000 });
    await page.waitForTimeout(400);
    return;
  }
  if (n === 1) {
    await match.first().click({ timeout: 4000 });
    await page.waitForTimeout(400);
    return;
  }
  const any = page.locator(".x-boundlist-item").first();
  if ((await any.count()) > 0) {
    await any.click({ timeout: 3000 });
  } else {
    await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(400);
};

const fillCellByDblClick = async (page, frame, rowIndex, colIndex, value, meta) => {
  if (colIndex === undefined) {
    throw new Error(`Missing column index for value ${String(value).slice(0, 20)}`);
  }
  await dismissDialogs(page);
  await dblClickGridCell(frame, rowIndex, colIndex, meta);
  await page.keyboard.press("Control+a").catch(() => undefined);
  await page.waitForTimeout(120);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await page.waitForTimeout(120);
  await page.keyboard.type(String(value), { delay: 32 });
  await page.waitForTimeout(450);
  await pickBoundlistForValue(page, value);
};

const fillAnalyticsCell = async (page, frame, rowIndex, colIndex, objectName, meta) => {
  if (colIndex === undefined) {
    throw new Error("Missing analytics column");
  }
  await dismissDialogs(page);
  await dblClickGridCell(frame, rowIndex, colIndex, meta);
  await page.keyboard.press("Control+a").catch(() => undefined);
  await page.waitForTimeout(120);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await page.waitForTimeout(120);
  await page.keyboard.type(String(objectName), { delay: 35 });
  await page.waitForTimeout(600);
  const re = new RegExp(escapeRegex(String(objectName).slice(0, 36)), "i");
  const items = page.locator(".x-boundlist-item").filter({ hasText: re });
  const c = await items.count();
  if (c === 0) {
    await page.keyboard.press("Escape");
    throw new Error("Row skipped: No matching name found in analytics list");
  }
  if (c > 1) {
    await items.first().click({ timeout: 4000 });
    await page.waitForTimeout(400);
    return { warning: "Multiple similar names found; first option selected" };
  }
  await items.first().click({ timeout: 4000 });
  await page.waitForTimeout(400);
  return { warning: null };
};

const finalValidationOrThrow = async (frame, rowIndex) => {
  const page = frame.page();
  await page.waitForTimeout(700);
  const fresh = await extractBalanceGridRows(frame);
  const row = fresh.rows[rowIndex];
  if (!row) {
    throw new Error("Row skipped: Incomplete data after processing");
  }
  const check = evaluateBalanceRow(row);
  if (check.outcome === "ready_for_document") {
    return;
  }
  if (check.outcome === "skipped" && String(check.message || "").includes("already processed")) {
    return;
  }
  if (check.outcome === "pending_automation") {
    throw new Error("Row skipped: Incomplete data after processing");
  }
  throw new Error(check.message || "Row skipped: Incomplete data after processing");
};

const clickCreateDocument = async (page) => {
  const candidates = [
    page.getByText("დოკუმენტის შექმნა", { exact: false }),
    page.locator('[title*="დოკუმენტის შექმნა"]').first(),
    page.locator('button:has-text("დოკუმენტის")').first(),
  ];
  for (const loc of candidates) {
    try {
      if ((await loc.count()) > 0) {
        await loc.first().click({ timeout: 10000 });
        await page.waitForTimeout(2200);
        await dismissDialogs(page);
        return;
      }
    } catch {
      // Try next.
    }
  }
  throw new Error('Could not click "დოკუმენტის შექმნა"');
};

export const balanceSessionLogout = async (page) => {
  const candidates = [
    page.getByText("გასვლა", { exact: false }),
    page.getByText("გამოსვლა", { exact: false }),
    page.locator('a[href*="logout" i]').first(),
  ];
  for (const loc of candidates) {
    try {
      if ((await loc.count()) > 0) {
        await loc.first().click({ timeout: 5000 });
        await page.waitForTimeout(1800);
        return;
      }
    } catch {
      // Try next.
    }
  }
};

export const runBalancePerRowAutomation = async (page, gridFrame, markStep, options = {}) => {
  const { skipLogout = false, gridDetection = null } = options;
  await dismissDialogs(page);
  const initial = await extractBalanceGridRows(gridFrame);
  if (initial.rows.length === 0) {
    markStep("no-grid-rows-synthetic-outcome");
    const waited = gridDetection?.waitedMs ?? 0;
    const hints = gridDetection?.hints ?? [];
    return [
      {
        rowIndex: 0,
        rowKey: "balance-grid-detection",
        outcome: "skipped",
        message: `გრიდიდან 0 სტრიქონი — წესები თითო უჯრეზე ვერ გაეშვა (${waited}ms ლოდინის შემდეგ).`,
        objectName: null,
        transactionType: "unknown",
        amountText: "",
        warning: null,
        detailJson: JSON.stringify({
          reason: "zero_extracted_rows",
          waitedMs: waited,
          interpretationHints: hints,
        }),
      },
    ];
  }
  const outcomes = evaluateBalanceRows(initial.rows);
  const colMap = await getColumnIndicesByKey(gridFrame);

  markStep("rule-step-5-mcc-filter-global");
  await tryApplyGlobalMccFilter(page, gridFrame);
  await page.waitForTimeout(600);

  const purposeCol = colMap.purpose;
  const loadingCol = colMap.loadingRule;
  const corrCol = colMap.corrAccount;
  const analyticsCol = colMap.analytics;

  for (let i = initial.rows.length - 1; i >= 0; i -= 1) {
    const snapRow = initial.rows[i];
    const plan = getRowUiPlan(snapRow);
    markStep(`row-${i}-${plan.skip ? "skipped-by-rules" : plan.mode}`);

    if (plan.skip) {
      continue;
    }

    await dismissDialogs(page);
    const fresh = await extractBalanceGridRows(gridFrame);
    const idx = findMatchingRowIndex(fresh.rows, snapRow);
    if (idx < 0) {
      outcomes[i].outcome = "automation_failed";
      outcomes[i].message = "Row skipped: could not locate row in grid during automation";
      continue;
    }

    try {
      const rowMeta = getGridInteractionMeta(colMap, fresh.rows[idx]);
      markStep(`row-${i}-step-5-purpose-mcc`);
      await runStep5PurposeMcc(page, gridFrame, idx, purposeCol, rowMeta);

      if (plan.mode === "full") {
        markStep(`row-${i}-step-8-loading-rule`);
        await fillCellByDblClick(page, gridFrame, idx, loadingCol, LOADING_VALUE, rowMeta);
        markStep(`row-${i}-step-8-corr-account`);
        await fillCellByDblClick(page, gridFrame, idx, corrCol, CORR_VALUE, rowMeta);
        markStep(`row-${i}-step-9-analytics`);
        const analyticsResult = await fillAnalyticsCell(
          page,
          gridFrame,
          idx,
          analyticsCol,
          plan.evaluation.objectName,
          rowMeta,
        );
        if (analyticsResult?.warning) {
          outcomes[i].warning = analyticsResult.warning;
        }
      }

      markStep(`row-${i}-step-11-final-validation`);
      await finalValidationOrThrow(gridFrame, idx);

      markStep(`row-${i}-step-12-document`);
      await clickRowCheckbox(gridFrame, idx, rowMeta);
      await clickCreateDocument(page);

      outcomes[i].outcome = "document_created";
      outcomes[i].message = "Row completed: steps 1–12 (document creation)";
    } catch (err) {
      outcomes[i].outcome = "automation_failed";
      outcomes[i].message = err instanceof Error ? err.message : String(err);
    }

    await dismissDialogs(page);
    await page.waitForTimeout(500);
  }

  if (!skipLogout) {
    markStep("rule-step-13-logout");
    await balanceSessionLogout(page);
  }

  return outcomes;
};
