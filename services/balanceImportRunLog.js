const deriveCountsFromSummary = (summary) => {
  const s = summary || {};
  const total = Number(s.total) || 0;
  const autoBooked = Number(s.document_created) || 0;
  const failedRule = Number(s.failed_rule) || 0;
  const pendingAutomation = Number(s.pending_automation) || 0;
  const readyForDocument = Number(s.ready_for_document) || 0;
  const automationFailed = Number(s.automation_failed) || 0;
  const needsReview = failedRule + pendingAutomation + readyForDocument;
  return {
    totalRows: total,
    autoBookedCount: autoBooked,
    needsReviewCount: needsReview,
    failedCount: automationFailed,
  };
};

const collectRowErrors = (rowOutcomes) => {
  const list = [];
  for (const row of rowOutcomes || []) {
    const o = row?.outcome;
    if (o === "automation_failed" || o === "failed_rule") {
      list.push({
        rowIndex: row.rowIndex,
        outcome: o,
        message: row.message || null,
      });
    }
  }
  return list;
};

export const recordBalanceImportRun = async (db, payload) => {
  const {
    companyId,
    importId,
    runStatus,
    rowOutcomeSummary,
    rowOutcomes,
    processingSeconds,
    workflowError,
  } = payload;

  const counts = deriveCountsFromSummary(rowOutcomeSummary);
  const rowErrs = collectRowErrors(rowOutcomes);
  let errorsPayload = null;
  if (workflowError) {
    const msg = workflowError instanceof Error ? workflowError.message : String(workflowError);
    errorsPayload = { workflow: msg };
  } else if (rowErrs.length > 0) {
    errorsPayload = { rows: rowErrs };
  }
  const errorsJson = errorsPayload ? JSON.stringify(errorsPayload) : null;
  const rowOutcomeSummaryJson = rowOutcomeSummary
    ? JSON.stringify(rowOutcomeSummary)
    : null;

  const timestampIso = new Date().toISOString();
  const logLine = {
    timestamp: timestampIso,
    companyId,
    importId,
    runStatus,
    totalRows: counts.totalRows,
    autoBookedCount: counts.autoBookedCount,
    needsReviewCount: counts.needsReviewCount,
    failedCount: counts.failedCount,
    processingSeconds,
    errors: errorsPayload,
  };
  console.log(`[balance-import-run] ${JSON.stringify(logLine)}`);

  const insertResult = await db.run(
    `INSERT INTO balance_import_run_logs (
       companyId, importId, runStatus, totalRows, autoBookedCount, needsReviewCount, failedCount,
       processingSeconds, errorsJson, rowOutcomeSummaryJson
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      companyId,
      importId,
      runStatus,
      counts.totalRows,
      counts.autoBookedCount,
      counts.needsReviewCount,
      counts.failedCount,
      processingSeconds,
      errorsJson,
      rowOutcomeSummaryJson,
    ],
  );

  const logId = insertResult?.lastID ?? 0;

  return {
    logId,
    timestamp: timestampIso,
    companyId,
    importId,
    runStatus,
    totalRows: counts.totalRows,
    autoBookedCount: counts.autoBookedCount,
    needsReviewCount: counts.needsReviewCount,
    failedCount: counts.failedCount,
    processingSeconds,
    errors: errorsPayload,
    errorsJson,
  };
};
