export const GRID_INTERPRETATION_HINTS_GEO = [
  "კომპანიამ შეიძლება ჯერ არ გადაუმუშავოს ოპერაციები Balance-ში — სტატუსები/ჩექბოქები ცარიელია, სანამ ხელით არ დაამუშავებენ.",
  "MCC/ბარათის ოპერაციებზე (დანიშნულებაში MCC) სტატუსის ინდიკატორები სხვაგვარად მუშაობს — ნულოვანი 'მწვანე/ცარიელი' ანგარიში არ ნიშნავს, რომ ტრანზაქციები საერთოდ არ ჩანს.",
  "ახალი კომპანია/წესების გარეშე — შესაძლოა ანალიტიკის ცნობარი ან ჩატვირთვის წესები არ იყოს მორგებული; ჩანაწერები შეიძლება წესებით იჭრებოდეს (იხილე ChatGPT workflow).",
  "თუ 'სტრიქონები 0' რჩება: გრიდი სხვა iframe-შია ან ExtJS DOM განსხვავებულია — ჩართე Debug რეჟიმი და გადაამოწმე, ჩანს თუ არა ცხრილი ეკრანზე OK-ის შემდეგ.",
];

export const waitForBalanceGridData = async (page, timeoutMs = 120000) => {
  const started = Date.now();
  const interval = Math.min(4000, Math.max(700, Number(process.env.BALANCE_GRID_POLL_MS ?? 1500)));
  let last = { rows: [], headerLabels: [], frame: null };

  while (Date.now() - started < timeoutMs) {
    const frames = [page.mainFrame(), ...page.frames()];
    for (const frame of frames) {
      try {
        const data = await extractBalanceGridRows(frame);
        last = { rows: data.rows, headerLabels: data.headerLabels, frame };
        if (data.rows.length > 0) {
          return {
            frame,
            rows: data.rows,
            headerLabels: data.headerLabels,
            extractedRowCount: data.rows.length,
            waitedMs: Date.now() - started,
            ok: true,
          };
        }
      } catch {
        // Ignore.
      }
    }
    await page.waitForTimeout(interval);
  }

  const fallbackFrame = last.frame ?? page.mainFrame();
  return {
    frame: fallbackFrame,
    rows: last.rows || [],
    headerLabels: last.headerLabels || [],
    extractedRowCount: (last.rows || []).length,
    waitedMs: Date.now() - started,
    ok: false,
  };
};

const HEADER_MAP = [
  { key: "purpose", needles: ["დანიშნულება"] },
  { key: "corrAccount", needles: ["კორ ანგარიში", "კორ. ანგარიში"] },
  { key: "loadingRule", needles: ["ჩატვირთვის წესი"] },
  { key: "analytics", needles: ["ანალიტიკა"] },
  { key: "amount", needles: ["თანხა", "თანრიცხვა", "ჯამი"] },
];

const normalizeHeader = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export const matchHeaderKey = (headerText) => {
  const n = normalizeHeader(headerText);
  if (!n) {
    return null;
  }
  for (const { key, needles } of HEADER_MAP) {
    for (const needle of needles) {
      if (n.includes(normalizeHeader(needle))) {
        return key;
      }
    }
  }
  return null;
};

export const extractBalanceGridRows = async (frame) => {
  const payload = await frame.evaluate(() => {
    const cellText = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();

    const isVisible = (el) => {
      if (!el) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const parseOneCGridBoxes = (line) => {
      const boxes = Array.from(line.querySelectorAll(".gridBox")).filter(isVisible);
      boxes.sort(
        (a, b) =>
          Number(a.getAttribute("colindex") || 0) - Number(b.getAttribute("colindex") || 0),
      );
      return boxes;
    };

    const extractOneCGrid = () => {
      const body = document.querySelector(".gridBody");
      if (!body) {
        return null;
      }
      let gridLines = Array.from(body.querySelectorAll(".gridLine")).filter(isVisible);
      if (gridLines.length === 0) {
        return null;
      }
      gridLines.sort(
        (a, b) =>
          Number(a.getAttribute("rowindex") ?? 0) - Number(b.getAttribute("rowindex") ?? 0),
      );

      const headerRoot = document.querySelector(".gridHead");
      let headerBoxes = [];
      if (headerRoot) {
        const hLines = Array.from(headerRoot.querySelectorAll(".gridLine")).filter(isVisible);
        const headerRow = hLines.length > 0 ? hLines[hLines.length - 1] : null;
        if (headerRow) {
          headerBoxes = parseOneCGridBoxes(headerRow);
        }
      }

      const headers = headerBoxes.map((box) => {
        const colindex = String(box.getAttribute("colindex") ?? "");
        const label = cellText(box.querySelector(".gridBoxText") || box.querySelector(".gridBoxTitle") || box);
        return { colindex, label };
      });

      const rows = gridLines.map((line, idx) => {
        const boxes = parseOneCGridBoxes(line);
        const valueByCol = {};
        for (const box of boxes) {
          const ci = String(box.getAttribute("colindex") ?? "");
          if (!ci) {
            continue;
          }
          valueByCol[ci] = cellText(box.querySelector(".gridBoxText") || box.querySelector(".gridBoxTitle") || box);
        }
        const stableRowKey = String(line.getAttribute("rowindex") ?? idx);
        const cb = line.querySelector(".checkbox[check='true'], .checkbox[check=\"true\"]");
        const checkboxChecked =
          cb !== null ||
          line.querySelector(".checkbox .zoomI")?.closest?.(".checkbox")?.getAttribute("check") === "true";
        const joinedParts = headers
          .map((h) => {
            const v = valueByCol[h.colindex] ?? "";
            return `${h.label}: ${v}`.trim();
          })
          .filter((p) => p.length > 0);
        const joined = joinedParts.join(" | ");
        const values = boxes.map((b) =>
          cellText(b.querySelector(".gridBoxText") || b.querySelector(".gridBoxTitle") || b),
        );
        return {
          rowIndex: idx,
          values,
          joined,
          checkboxChecked: Boolean(checkboxChecked),
          stableRowKey,
          valueByCol,
        };
      });

      const orderedHeaders = headers.map((h) => h.label).filter((t) => t.length > 0);

      return {
        mode: "1c",
        orderedHeaders,
        headerColIndexes: headers,
        parsedRows: rows,
      };
    };


    const oneC = extractOneCGrid();
    if (oneC && oneC.parsedRows.length > 0) {
      return oneC;
    }

    const isHeaderRow = (row) =>
      Boolean(
        row.closest?.(".x-grid-header") ||
          row.classList?.contains?.("x-grid-header-row") ||
          row.getAttribute?.("role") === "columnheader",
      );

    const headerFromRow = () => {
      const roots = [
        ...Array.from(document.querySelectorAll("tr.x-grid-header-row")),
        ...Array.from(document.querySelectorAll(".x-grid-header")),
      ];
      for (const root of roots) {
        const rect = root.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const innerTexts = Array.from(
          root.querySelectorAll(".x-column-header-text, .x-column-header-inner .x-column-header-text"),
        );
        const labels = innerTexts.map((el) => cellText(el)).filter((t) => t.length > 0 && t.length < 120);
        if (labels.length >= 3) {
          return labels;
        }
      }
      return [];
    };

    const headerCandidates = Array.from(
      document.querySelectorAll(
        ".x-column-header-text, .x-column-header-inner, .x-column-header .x-column-header-text, th, .x-grid-header .x-column-header",
      ),
    );

    const fallbackLabels = [];
    const seen = new Set();
    for (const el of headerCandidates) {
      const t = cellText(el);
      if (t.length > 0 && t.length < 120 && !seen.has(t)) {
        seen.add(t);
        fallbackLabels.push(t);
      }
    }

    const fromRow = headerFromRow();
    const orderedHeaders = fromRow.length >= 2 ? fromRow : fallbackLabels;

    const rowSelectors = [
      "tbody tr.x-grid-row",
      "tr.x-grid-row",
      ".x-grid-item-container > .x-grid-item",
      ".x-grid-item-container .x-grid-item",
      "div.x-grid-item",
      ".x-grid-item",
      ".x-grid-row",
      "div.x-grid-row",
      "table.x-grid-item",
      "[data-recordid]",
    ];
    let rows = [];
    for (const selector of rowSelectors) {
      rows = Array.from(document.querySelectorAll(selector)).filter((row) => {
        if (isHeaderRow(row)) {
          return false;
        }
        return isVisible(row);
      });
      if (rows.length > 0) {
        break;
      }
    }

    const cellQuery =
      "td, .x-grid-cell, .x-grid-cell-inner, .x-grid-td, .x-grid-rowbody, [class*=\"grid-cell\"]";

    const parsedRows = rows.map((row, rowIndex) => {
      let cells = Array.from(row.querySelectorAll(cellQuery)).filter(isVisible);
      let values = cells.map((c) => cellText(c)).filter((t) => t.length > 0);
      if (values.length === 0) {
        const fallback = cellText(row);
        if (fallback.length > 2) {
          values = [fallback];
        }
      }
      const joined = values.join(" | ");
      const checkboxChecked =
        row.querySelector("input[type=checkbox]:checked") !== null ||
        row.querySelector(".x-grid-checkcolumn-checked") !== null ||
        row.querySelector('[aria-checked="true"]') !== null ||
        /checkcolumn-checked|checkbox-checked|\bchecked\b/i.test(row.innerHTML || "");
      return { rowIndex, values, joined, checkboxChecked };
    });

    return { mode: "ext", orderedHeaders, parsedRows };
  });

  const filterNonEmptyRows = (list) =>
    list.filter((r) => {
      const j = String(r.rawJoined || "").trim();
      if (j.length > 0) {
        return true;
      }
      return Boolean(
        String(r.purpose || "").trim() ||
          String(r.amount || "").trim() ||
          String(r.corrAccount || "").trim(),
      );
    });

  if (payload.mode === "1c" && Array.isArray(payload.headerColIndexes)) {
    const columnColIndexByKey = {};
    for (const { colindex, label } of payload.headerColIndexes) {
      const key = matchHeaderKey(label);
      if (key && columnColIndexByKey[key] === undefined) {
        columnColIndexByKey[key] = Number.parseInt(String(colindex), 10);
      }
    }

    const rows = payload.parsedRows.map((pr) => {
      const byKey = {
        purpose: "",
        corrAccount: "",
        loadingRule: "",
        analytics: "",
        amount: "",
        rawJoined: pr.joined,
        checkboxChecked: Boolean(pr.checkboxChecked),
      };
      for (const { colindex, label } of payload.headerColIndexes) {
        const key = matchHeaderKey(label);
        const val = (pr.valueByCol && pr.valueByCol[colindex]) || "";
        if (key && val && !byKey[key]) {
          byKey[key] = val;
        }
      }
      if (!byKey.purpose && pr.joined) {
        byKey.purpose = pr.joined;
      }
      return {
        rowIndex: pr.rowIndex,
        ...byKey,
        stableRowKey: pr.stableRowKey,
        gridKind: "1c",
      };
    });

    return {
      headerLabels: payload.orderedHeaders,
      rows: filterNonEmptyRows(rows),
      gridKind: "1c",
      columnColIndexByKey,
    };
  }

  const columnKeyByIndex = new Map();
  payload.orderedHeaders.forEach((label, idx) => {
    const key = matchHeaderKey(label);
    if (key && !columnKeyByIndex.has(idx)) {
      columnKeyByIndex.set(idx, key);
    }
  });

  const rows = payload.parsedRows.map(({ rowIndex, values, joined, checkboxChecked }) => {
    const byKey = {
      purpose: "",
      corrAccount: "",
      loadingRule: "",
      analytics: "",
      amount: "",
      rawJoined: joined,
      checkboxChecked: Boolean(checkboxChecked),
    };
    values.forEach((text, colIdx) => {
      const key = columnKeyByIndex.get(colIdx);
      if (key && text) {
        if (!byKey[key]) {
          byKey[key] = text;
        }
      }
    });
    if (!byKey.purpose && joined) {
      byKey.purpose = joined;
    }
    return { rowIndex, ...byKey, gridKind: "ext" };
  });

  return {
    headerLabels: payload.orderedHeaders,
    rows: filterNonEmptyRows(rows),
    gridKind: "ext",
    columnColIndexByKey: null,
  };
};

export const getColumnIndicesByKey = async (frame) => {
  const data = await extractBalanceGridRows(frame);
  const out = { gridKind: data.gridKind ?? "ext" };
  if (data.gridKind === "1c" && data.columnColIndexByKey) {
    Object.assign(out, data.columnColIndexByKey);
    return out;
  }
  data.headerLabels.forEach((label, idx) => {
    const key = matchHeaderKey(label);
    if (key && out[key] === undefined) {
      out[key] = idx;
    }
  });
  return out;
};
