export const MSG = {
  corrWithoutAnalytics:
    "Row invalid: კორ ანგარიში is filled but ანალიტიკა is empty (არასწორი — საჭიროა ანალიტიკა).",
  missingCorrNoMcc:
    "Row skipped: Missing კორ ანგარიში and no MCC reference in დანიშნულება (insufficient data to process)",
  mccNotFound: "Row skipped: MCC reference not found in დანიშნულება",
  objectExtract: "Row skipped: Unable to extract object name from დანიშნულება",
  notOutgoing: "Row skipped: Not თანხის გასვლა with amount > 0",
  analyticsNoMatch: "Row skipped: No matching name found in analytics list",
  incompleteAfter: "Row skipped: Incomplete data after processing",
};

const OUTGOING = "თანხის გასვლა";
const INCOMING = "თანხის შემოსვლა";
const LOADING_VALUE = "მომწოდებლისთვის თანხის გადახდა";
const CORR_VALUE = "3110.01";

const extractObjectName = (purpose) => {
  const text = String(purpose || "");
  const match = text.match(/ობიექტი\s*:\s*([^;]+)/i);
  if (!match) {
    return null;
  }
  const name = String(match[1] || "").trim();
  return name.length > 0 ? name : null;
};

const parseAmount = (amountText, rowJoined) => {
  const source = `${amountText || ""} ${rowJoined || ""}`;
  const normalized = source.replace(/\s/g, "").replace(",", ".");
  const matches = normalized.match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) {
    return null;
  }
  const nums = matches.map((m) => Number.parseFloat(m)).filter((n) => !Number.isNaN(n));
  if (nums.length === 0) {
    return null;
  }
  return Math.max(...nums.map((n) => Math.abs(n)));
};

const detectTransactionType = (rowJoined) => {
  const j = String(rowJoined || "");
  if (j.includes(OUTGOING)) {
    return "outgoing";
  }
  if (j.includes(INCOMING)) {
    return "incoming";
  }
  return "unknown";
};

const analyticsMatchQuality = (objectName, analyticsCell) => {
  const o = String(objectName || "").trim();
  const a = String(analyticsCell || "").trim();
  if (!o) {
    return "none";
  }
  if (!a) {
    return "empty";
  }
  if (a === o) {
    return "exact";
  }
  if (a.includes(o) || o.includes(a)) {
    return "partial";
  }
  return "none";
};

export const evaluateBalanceRow = (row) => {
  if (row.checkboxChecked) {
    return {
      outcome: "skipped",
      message: "Row skipped: already processed (checkbox)",
      objectName: null,
      transactionType: detectTransactionType(String(row.rawJoined || "")),
      amountText: row.amount || "",
    };
  }

  const purpose = String(row.purpose || "").trim();
  const corrRaw = String(row.corrAccount || "").trim();
  const loadingRaw = String(row.loadingRule || "").trim();
  const analyticsRaw = String(row.analytics || "").trim();
  const joined = String(row.rawJoined || "");

  const corrEmpty = corrRaw.length === 0;
  const analyticsEmpty = analyticsRaw.length === 0;
  const hasMcc = /MCC/i.test(purpose);

  if (!corrEmpty && analyticsEmpty) {
    return {
      outcome: "failed_rule",
      message: MSG.corrWithoutAnalytics,
      objectName: null,
      transactionType: detectTransactionType(joined),
      amountText: row.amount || "",
    };
  }

  if (corrEmpty && analyticsEmpty && !hasMcc) {
    return {
      outcome: "skipped",
      message: MSG.missingCorrNoMcc,
      objectName: null,
      transactionType: detectTransactionType(joined),
      amountText: row.amount || "",
    };
  }

  if (!hasMcc) {
    return {
      outcome: "skipped",
      message: MSG.mccNotFound,
      objectName: null,
      transactionType: detectTransactionType(joined),
      amountText: row.amount || "",
    };
  }

  const objectName = extractObjectName(purpose);
  if (!objectName) {
    return {
      outcome: "skipped",
      message: MSG.objectExtract,
      objectName: null,
      transactionType: detectTransactionType(joined),
      amountText: row.amount || "",
    };
  }

  const transactionType = detectTransactionType(joined);
  const amount = parseAmount(row.amount, joined);
  const outgoingOk = transactionType === "outgoing" && amount !== null && amount > 0;

  if (!outgoingOk) {
    return {
      outcome: "skipped",
      message: MSG.notOutgoing,
      objectName,
      transactionType,
      amountText: String(amount ?? ""),
    };
  }

  const corrEffective = corrEmpty ? CORR_VALUE : corrRaw;
  const loadingEffective = loadingRaw.length === 0 ? LOADING_VALUE : loadingRaw;

  const match = analyticsMatchQuality(objectName, analyticsRaw);
  if (match === "none" && analyticsRaw.length > 0) {
    return {
      outcome: "skipped",
      message: MSG.analyticsNoMatch,
      objectName,
      transactionType,
      amountText: String(amount ?? ""),
      warning: null,
    };
  }

  if (match === "empty") {
    return {
      outcome: "pending_automation",
      message:
        "Row pending: analytics field empty — requires UI pick from list (rule 9–10)",
      objectName,
      transactionType,
      amountText: String(amount ?? ""),
      warning: null,
      simulatedCorr: corrEffective,
      simulatedLoadingRule: loadingEffective,
    };
  }

  const warning =
    match === "partial" ? "Multiple similar names found; first option selected" : null;

  const corrOk = corrEffective.includes("3110") || corrEffective === CORR_VALUE;
  const loadOk =
    loadingEffective.includes("მომწოდებლისთვის") || loadingEffective.includes("გადახდა");
  const analyticsOk = match === "exact" || match === "partial";

  if (!corrOk || !loadOk || !analyticsOk) {
    return {
      outcome: "skipped",
      message: MSG.incompleteAfter,
      objectName,
      transactionType,
      amountText: String(amount ?? ""),
      warning,
    };
  }

  return {
    outcome: "ready_for_document",
    message: "Row passed rules — select checkbox and create document (step 12)",
    objectName,
    transactionType,
    amountText: String(amount ?? ""),
    warning,
    simulatedCorr: corrEffective,
    simulatedLoadingRule: loadingEffective,
  };
};

export const getRowUiPlan = (row) => {
  const evaluation = evaluateBalanceRow(row);
  if (evaluation.outcome === "skipped" || evaluation.outcome === "failed_rule") {
    return { skip: true, evaluation };
  }
  if (evaluation.outcome === "pending_automation") {
    return { skip: false, mode: "full", evaluation };
  }
  if (evaluation.outcome === "ready_for_document") {
    return { skip: false, mode: "document_only", evaluation };
  }
  return { skip: true, evaluation };
};

export const evaluateBalanceRows = (rows) => {
  return rows.map((row, idx) => {
    const evaluation = evaluateBalanceRow(row);
    return {
      rowIndex: row.rowIndex ?? idx,
      rowKey: `row:${row.rowIndex ?? idx}`,
      ...evaluation,
      detailJson: JSON.stringify({
        purposeSample: String(row.purpose || "").slice(0, 500),
        corrAccount: row.corrAccount,
        loadingRule: row.loadingRule,
        analytics: row.analytics,
        corrEmpty: !String(row.corrAccount || "").trim(),
        analyticsEmpty: !String(row.analytics || "").trim(),
        checkboxChecked: Boolean(row.checkboxChecked),
      }),
    };
  });
};

export const summarizeRowOutcomes = (outcomes) => {
  const summary = {
    total: outcomes.length,
    skipped: 0,
    failed_rule: 0,
    document_created: 0,
    automation_failed: 0,
    pending_automation: 0,
    ready_for_document: 0,
    byMessage: {},
  };
  for (const o of outcomes) {
    if (o.outcome === "document_created") {
      summary.document_created += 1;
    } else if (o.outcome === "automation_failed") {
      summary.automation_failed += 1;
    } else if (o.outcome === "failed_rule") {
      summary.failed_rule += 1;
    } else if (o.outcome === "skipped") {
      summary.skipped += 1;
    } else if (o.outcome === "pending_automation") {
      summary.pending_automation += 1;
    } else if (o.outcome === "ready_for_document") {
      summary.ready_for_document += 1;
    }
    const key = o.message || o.outcome;
    summary.byMessage[key] = (summary.byMessage[key] || 0) + 1;
  }
  return summary;
};
