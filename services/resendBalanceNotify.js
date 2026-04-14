import { profile } from "../config/index.js";
import { DEFAULT_RESEND_API_KEY } from "../config/resendDefaults.js";
import {
  buildBalanceReportHtml,
  formatRowOutcomeSummaryLines,
  formatRowOutcomesHumanText,
} from "./balanceReportFormat.js";

const RESEND_API = "https://api.resend.com/emails";
const DEFAULT_NOTIFY_EMAIL = "gegagagua@gmail.com";
const DEFAULT_FROM = "Bookwise <info@book-wise.ge>";
const RESEND_SANDBOX_FROM = "Bookwise <onboarding@resend.dev>";
const MAX_BODY_CHARS = 45_000;
const MAX_HTML_CHARS = 200_000;

const clipHtml = (html) => {
  if (html.length <= MAX_HTML_CHARS) {
    return html;
  }
  return `${html.slice(0, MAX_HTML_CHARS)}\n<!-- truncated -->`;
};

const resolveApiKey = () => process.env.RESEND_API_KEY?.trim() || DEFAULT_RESEND_API_KEY;

const resolveNotifyEmail = () =>
  process.env.BALANCE_NOTIFY_EMAIL?.trim() ||
  process.env.RESEND_NOTIFY_EMAIL?.trim() ||
  DEFAULT_NOTIFY_EMAIL;

const simpleEmailOk = (value) => {
  const t = String(value ?? "").trim();
  if (!t || t.length > 254) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
};

const pickBalanceReportRecipient = (notifyTo) => {
  if (simpleEmailOk(notifyTo)) {
    return String(notifyTo).trim();
  }
  return resolveNotifyEmail();
};

const resolveFrom = () => process.env.RESEND_FROM?.trim() || DEFAULT_FROM;

const buildFromCandidates = () => {
  const preferred = resolveFrom();
  const list = [];
  const add = (v) => {
    const t = String(v ?? "").trim();
    if (t.length > 0 && !list.includes(t)) {
      list.push(t);
    }
  };
  add(preferred);
  add(DEFAULT_FROM);
  add(process.env.RESEND_FROM_FALLBACK?.trim());
  const allowSandbox =
    profile !== "prod" || String(process.env.RESEND_ALLOW_SANDBOX_FROM ?? "").trim() === "1";
  if (allowSandbox) {
    add(RESEND_SANDBOX_FROM);
  }
  return list;
};

const shouldRetryResendWithFallbackFrom = (httpStatus, data) => {
  if (httpStatus !== 403 && httpStatus !== 422) {
    return false;
  }
  const blob = `${JSON.stringify(data ?? {})}`.toLowerCase();
  return (
    blob.includes("domain") ||
    blob.includes("verify") ||
    blob.includes("invalid 'from'") ||
    blob.includes("from field") ||
    blob.includes("sender") ||
    blob.includes("restricted")
  );
};

const toJson = (value) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const clip = (text) => {
  if (text.length <= MAX_BODY_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`;
};

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const compactResultForEmail = (result) => {
  if (!result || typeof result !== "object") {
    return null;
  }
  const a = result.analytics && typeof result.analytics === "object" ? result.analytics : {};
  return {
    message: result.message,
    rowOutcomeSummary: result.rowOutcomeSummary,
    rowOutcomes: result.rowOutcomes,
    uploadedFile: result.uploadedFile,
    analyticsLite: {
      totalRowsSeen: a.totalRowsSeen,
      scrollPasses: a.scrollPasses,
      gridExtraction: a.gridExtraction,
      checkedCount: a.checked?.count,
      greenCount: a.greenCircle?.count,
      emptyCount: a.emptyCircle?.count,
    },
    stepsTail:
      Array.isArray(result.steps) && result.steps.length > 80
        ? result.steps.slice(-80)
        : result.steps,
  };
};

const formatUploadContextText = (excelTotalRows, rowOutcomeSummary) => {
  const summary = rowOutcomeSummary && typeof rowOutcomeSummary === "object" ? rowOutcomeSummary : null;
  return [
    "── File / counts ──",
    `Excel rows (upload totalRows): ${excelTotalRows ?? "—"}`,
    `Automation rows (summary.total): ${summary?.total ?? "—"}`,
    "",
  ].join("\n");
};

const formatRunLogProof = (runLog) => {
  if (!runLog || typeof runLog !== "object") {
    return "";
  }
  const e = runLog.errors;
  let errBrief = "—";
  if (e?.workflow) {
    errBrief = String(e.workflow);
  } else if (Array.isArray(e?.rows) && e.rows.length > 0) {
    errBrief = `${e.rows.length} row-level issue(s)`;
  }
  const lines = [
    "=== Balance run log (DB + sales proof) ===",
    `Log id (balance_import_run_logs): ${runLog.logId ?? "—"}`,
    `Timestamp (UTC): ${runLog.timestamp ?? "—"}`,
    `Company id: ${runLog.companyId ?? "—"}`,
    `Import id: ${runLog.importId ?? "—"}`,
    `Run status: ${runLog.runStatus ?? "—"}`,
    `Total rows (from outcome summary): ${runLog.totalRows ?? 0}`,
    `Auto-booked count (document_created): ${runLog.autoBookedCount ?? 0}`,
    `Needs-review count (rules + pending + ready_for_document): ${runLog.needsReviewCount ?? 0}`,
    `Failed count (automation_failed): ${runLog.failedCount ?? 0}`,
    `Processing time (seconds): ${runLog.processingSeconds ?? "—"}`,
    `Errors summary: ${errBrief}`,
    "",
    "---",
    "",
  ];
  return lines.join("\n");
};

const sendResendEmail = async ({ to, subject, text, html }) => {
  const apiKey = resolveApiKey();
  const bodyText = clip(text);
  const bodyHtml = clipHtml(
    html && typeof html === "string"
      ? html
      : `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(bodyText)}</pre>`,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28_000);
  const fromCandidates = buildFromCandidates();
  let lastFail = { httpStatus: 0, data: {} };
  try {
    for (let i = 0; i < fromCandidates.length; i += 1) {
      const from = fromCandidates[i];
      const response = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          from,
          to: [to],
          subject,
          text: bodyText,
          html: bodyHtml,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        clearTimeout(timer);
        if (i > 0) {
          console.warn("[resend] sent using fallback from after preferred rejected", {
            from,
            to,
            prevFrom: fromCandidates[0],
          });
        }
        console.log("[resend] email sent", { id: data.id, to, from });
        return { ok: true, httpStatus: response.status, data, fromUsed: from };
      }
      lastFail = { httpStatus: response.status, data };
      console.error("[resend] email rejected", response.status, data, { from, to });
      const hasMore = i < fromCandidates.length - 1;
      const canRetry = hasMore && shouldRetryResendWithFallbackFrom(response.status, data);
      if (!canRetry) {
        break;
      }
      console.warn("[resend] retrying with next from candidate", { next: fromCandidates[i + 1] });
    }
    clearTimeout(timer);
    return { ok: false, httpStatus: lastFail.httpStatus, data: lastFail.data };
  } catch (err) {
    clearTimeout(timer);
    console.error("[resend] email failed", err);
    return { ok: false, reason: "fetch_error", error: err instanceof Error ? err.message : String(err) };
  }
};

export async function sendBalanceRunEmailNotification({
  status,
  company,
  importRecord,
  result,
  error,
  runLog,
  notifyTo,
}) {
  const notifyEmail = pickBalanceReportRecipient(notifyTo);
  const recipientSource = simpleEmailOk(notifyTo) ? "user_profile" : "env_fallback";
  const sandboxFromEligible =
    profile !== "prod" || String(process.env.RESEND_ALLOW_SANDBOX_FROM ?? "").trim() === "1";
  const attachNotifyMeta = (out) => ({
    ...out,
    recipientEmail: notifyEmail,
    recipientSource,
    sandboxFromEligible,
  });
  const companyName = String(company?.name ?? "").trim() || "—";
  const companyId = company?.id ?? "—";
  const companyEmail = String(company?.email ?? "").trim() || "—";
  const importId = importRecord?.id ?? "—";
  const fileName = String(importRecord?.fileName ?? "").trim() || "—";
  const accountCode = String(importRecord?.accountCode ?? "").trim() || "—";
  const excelTotalRows =
    importRecord?.totalRows !== undefined && importRecord?.totalRows !== null
      ? importRecord.totalRows
      : "—";

  const subject = `[Bookwise] Balance run ${status === "success" ? "SUCCESS" : "FAILED"} — ${companyName} · import #${importId} · Excel rows: ${excelTotalRows}`;

  try {
    const proofBlock = formatRunLogProof(runLog);
    const uploadCtx = formatUploadContextText(
      excelTotalRows,
      status === "success" && result ? result.rowOutcomeSummary : null,
    );
    const summaryLinesArr = formatRowOutcomeSummaryLines(
      status === "success" && result ? result.rowOutcomeSummary : null,
    );
    const rowOutcomesForReport = status === "success" && result ? result.rowOutcomes : [];
    const rowsHumanLines = formatRowOutcomesHumanText(rowOutcomesForReport);
    const errMsg = error instanceof Error ? error.message : String(error ?? "Unknown error");
    const steps = error && typeof error === "object" && "steps" in error ? error.steps : undefined;

    const headerText = [
      proofBlock,
      uploadCtx,
      `Status: ${status}`,
      `Company: ${companyName} (id ${companyId})`,
      `Company login email: ${companyEmail}`,
      `Import id: ${importId}`,
      `File: ${fileName}`,
      `Account code: ${accountCode}`,
      "",
    ].join("\n");

    let technicalJson = "";
    if (status === "success" && result) {
      const serializable = { runLog: runLog ?? null, ...compactResultForEmail(result) };
      technicalJson = `\n\n── Technical JSON (truncated) ──\n${toJson(serializable).slice(0, 14_000)}`;
    } else {
      const serializable = { runLog: runLog ?? null, error: errMsg, steps: steps ?? null };
      technicalJson = `\n\n── Technical JSON (truncated) ──\n${toJson(serializable).slice(0, 10_000)}`;
    }

    const bodyText = clip(
      [
        headerText,
        summaryLinesArr.join("\n"),
        "",
        rowsHumanLines.join("\n"),
        technicalJson,
      ].join("\n"),
    );

    const metaLines = [
      `Company: ${companyName} (id ${companyId})`,
      `File: ${fileName} · Import #${importId}`,
      `Account: ${accountCode} · Login: ${companyEmail}`,
      `Bookwise user (recipient): ${notifyEmail}`,
      `Pipeline: ${status === "success" ? "Success" : "Failed"}`,
    ];
    if (status === "success" && result?.message) {
      metaLines.push(String(result.message).replace(/\s+/g, " ").trim().slice(0, 520));
    }
    if (status === "failed") {
      metaLines.push(`Error: ${String(errMsg).replace(/\s+/g, " ").trim().slice(0, 520)}`);
    }
    if (runLog?.timestamp) {
      metaLines.push(`Logged (UTC): ${runLog.timestamp}`);
    }
    if (runLog?.logId != null) {
      metaLines.push(`Run log id: ${runLog.logId}`);
    }

    const summaryForHtml = [...summaryLinesArr];
    const html = buildBalanceReportHtml({
      title: "Bookwise · Balance run report",
      metaLines,
      summaryLines: summaryForHtml,
      rowOutcomes: rowOutcomesForReport,
      footerNote:
        "Plain-text part of this email includes the same rows plus truncated JSON for support.",
      errorBanner: status === "failed" ? errMsg : "",
    });

    const out = await sendResendEmail({ to: notifyEmail, subject, text: bodyText, html });
    console.log("[resend] balance run report", {
      importId,
      status,
      ok: out.ok,
      to: notifyEmail,
      recipientSource,
      fromUsed: out.fromUsed,
      httpStatus: out.httpStatus,
      sandboxFromEligible,
    });
    return attachNotifyMeta(out);
  } catch (buildErr) {
    console.error("[resend] balance run report body failed, sending minimal mail", buildErr);
    const minimalText = [
      `Could not build full report: ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`,
      "",
      `Status: ${status}`,
      `Company: ${companyName} (id ${companyId})`,
      `Import id: ${importId}`,
      `File: ${fileName}`,
      `Account: ${accountCode}`,
      error instanceof Error ? `Error: ${error.message}` : error ? `Error: ${String(error)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const out = await sendResendEmail({
      to: notifyEmail,
      subject: `${subject} (summary only)`,
      text: minimalText,
    });
    console.log("[resend] balance run report (fallback)", {
      importId,
      status,
      ok: out.ok,
      to: notifyEmail,
      recipientSource,
      fromUsed: out.fromUsed,
      httpStatus: out.httpStatus,
      sandboxFromEligible,
    });
    return attachNotifyMeta(out);
  }
}

export async function sendResendTestEmail(message = "test") {
  return sendResendEmail({
    to: resolveNotifyEmail(),
    subject: "[Bookwise] Resend test",
    text: String(message),
  });
}

export async function sendBalanceNotifyProbeEmail(notifyTo) {
  const notifyEmail = pickBalanceReportRecipient(notifyTo);
  const when = new Date().toISOString();
  const out = await sendResendEmail({
    to: notifyEmail,
    subject: "[Bookwise] Balance notify test",
    text: [
      "Bookwise connectivity test (same recipient rules as balance run reports).",
      `Resolved recipient: ${notifyEmail}`,
      `UTC: ${when}`,
      "If this arrives but run reports do not, check run completion UI for Resend errors.",
    ].join("\n"),
  });
  return { ...out, recipientEmail: notifyEmail };
}
