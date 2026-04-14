const OUTCOME_LABELS = {
  skipped: "Skipped (rules / filter)",
  failed_rule: "Failed rule check",
  document_created: "Document created (booked)",
  ready_for_document: "Ready for document (post in 1C)",
  pending_automation: "Needs automation / data fix",
  automation_failed: "UI automation failed",
};

export const outcomeLabelEn = (code) => OUTCOME_LABELS[code] || String(code || "—");

const parseDetailJson = (raw) => {
  if (!raw || typeof raw !== "string") {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const oneLine = (s, max) => {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max)}…`;
};

export const formatRowOutcomeSummaryLines = (summary) => {
  const s = summary && typeof summary === "object" ? summary : null;
  if (!s) {
    return ["── Summary ──", "No row summary (run failed or not completed)."];
  }
  return [
    "── Summary ──",
    `Total rows: ${s.total ?? "—"}`,
    `Skipped: ${s.skipped ?? 0}`,
    `Failed rule: ${s.failed_rule ?? 0}`,
    `Document created (booked): ${s.document_created ?? 0}`,
    `Ready for document: ${s.ready_for_document ?? 0}`,
    `Pending automation: ${s.pending_automation ?? 0}`,
    `Automation failed: ${s.automation_failed ?? 0}`,
    "",
  ];
};

export const formatRowOutcomesHumanText = (rowOutcomes) => {
  const rows = Array.isArray(rowOutcomes) ? rowOutcomes : [];
  if (rows.length === 0) {
    return ["No per-row outcomes (run stopped early or empty grid).", ""];
  }
  const lines = ["── Rows (one block per line in 1C order) ──", ""];
  for (const r of rows) {
    const idx = r.rowIndex ?? "?";
    const code = r.outcome ?? "—";
    const label = outcomeLabelEn(code);
    const d = parseDetailJson(r.detailJson);
    lines.push(`▸ Row ${idx} — ${label} [${code}]`);
    if (r.objectName) {
      lines.push(`   Counterparty / object: ${oneLine(r.objectName, 200)}`);
    }
    if (r.transactionType && r.transactionType !== "unknown") {
      lines.push(`   Type: ${oneLine(r.transactionType, 80)}`);
    }
    if (r.amountText) {
      lines.push(`   Amount: ${oneLine(r.amountText, 80)}`);
    }
    if (d.purposeSample) {
      lines.push(`   Purpose: ${oneLine(d.purposeSample, 320)}`);
    }
    if (d.corrAccount) {
      lines.push(`   Corr. account: ${oneLine(d.corrAccount, 120)}`);
    }
    if (d.loadingRule) {
      lines.push(`   Loading rule: ${oneLine(d.loadingRule, 120)}`);
    }
    if (d.analytics) {
      lines.push(`   Analytics (grid): ${oneLine(d.analytics, 160)}`);
    }
    if (r.message) {
      lines.push(`   Message: ${oneLine(r.message, 500)}`);
    }
    if (r.warning) {
      lines.push(`   Warning: ${oneLine(r.warning, 240)}`);
    }
    lines.push("");
  }
  return lines;
};

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const buildBalanceReportHtml = ({
  title,
  metaLines,
  summaryLines,
  rowOutcomes,
  footerNote,
  errorBanner,
}) => {
  const rows = Array.isArray(rowOutcomes) ? rowOutcomes : [];
  const banner =
    errorBanner && String(errorBanner).trim()
      ? `<div style="margin:0 24px 16px;padding:12px 16px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#991b1b;font-size:13px;">${esc(
          oneLine(errorBanner, 1200),
        )}</div>`
      : "";
  const metaHtml = (metaLines || [])
    .filter(Boolean)
    .map((l) => `<tr><td style="padding:4px 0;color:#444;font-size:14px;">${esc(l)}</td></tr>`)
    .join("");
  const summaryHtml = (summaryLines || [])
    .filter(Boolean)
    .map((l) => `<div style="margin:2px 0;font-size:13px;color:#374151;">${esc(l)}</div>`)
    .join("");

  const rowCells = rows
    .map((r) => {
      const d = parseDetailJson(r.detailJson);
      const idx = r.rowIndex ?? "?";
      const code = r.outcome ?? "—";
      const label = outcomeLabelEn(code);
      const purpose = d.purposeSample ? oneLine(d.purposeSample, 400) : "—";
      const msg = r.message ? oneLine(r.message, 600) : "—";
      return `<tr style="border-bottom:1px solid #e5e7eb;">
<td style="padding:10px 8px;vertical-align:top;font-weight:600;">${esc(String(idx))}</td>
<td style="padding:10px 8px;vertical-align:top;"><span style="display:inline-block;padding:2px 8px;border-radius:6px;background:#f3f4f6;font-size:12px;">${esc(label)}</span><div style="font-size:11px;color:#6b7280;margin-top:4px;">${esc(code)}</div></td>
<td style="padding:10px 8px;vertical-align:top;font-size:13px;">${esc(r.objectName ? oneLine(r.objectName, 180) : "—")}</td>
<td style="padding:10px 8px;vertical-align:top;font-size:13px;">${esc(r.transactionType ? oneLine(r.transactionType, 60) : "—")}</td>
<td style="padding:10px 8px;vertical-align:top;font-size:13px;white-space:nowrap;">${esc(r.amountText ? oneLine(r.amountText, 40) : "—")}</td>
<td style="padding:10px 8px;vertical-align:top;font-size:12px;color:#374151;">${esc(purpose)}</td>
<td style="padding:10px 8px;vertical-align:top;font-size:12px;color:#1f2937;">${esc(msg)}</td>
</tr>`;
    })
    .join("");

  const emptyRow =
    '<tr><td colspan="7" style="padding:16px;color:#6b7280;font-size:13px;">No row outcomes.</td></tr>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#fafafa;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
<div style="max-width:900px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
<div style="padding:20px 24px;border-bottom:1px solid #e5e7eb;background:linear-gradient(180deg,#f9fafb 0%,#fff 100%);">
<h1 style="margin:0 0 8px;font-size:20px;color:#111827;">${esc(title)}</h1>
<table style="width:100%;border-collapse:collapse;">${metaHtml}</table>
</div>
${banner}
<div style="padding:16px 24px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
${summaryHtml}
</div>
<div style="padding:0 24px 24px;">
<p style="margin:16px 0 8px;font-size:14px;font-weight:600;color:#111827;">Rows</p>
<div style="overflow-x:auto;border:1px solid #e5e7eb;border-radius:8px;">
<table style="width:100%;border-collapse:collapse;font-size:13px;">
<thead><tr style="background:#f3f4f6;text-align:left;">
<th style="padding:10px 8px;font-weight:600;color:#374151;">#</th>
<th style="padding:10px 8px;font-weight:600;color:#374151;">Status</th>
<th style="padding:10px 8px;font-weight:600;color:#374151;">Object</th>
<th style="padding:10px 8px;font-weight:600;color:#374151;">Type</th>
<th style="padding:10px 8px;font-weight:600;color:#374151;">Amount</th>
<th style="padding:10px 8px;font-weight:600;color:#374151;">Purpose</th>
<th style="padding:10px 8px;font-weight:600;color:#374151;">Message</th>
</tr></thead>
<tbody>${rowCells || emptyRow}</tbody>
</table>
</div>
${footerNote ? `<p style="margin-top:16px;font-size:12px;color:#6b7280;">${esc(footerNote)}</p>` : ""}
</div>
</div>
</body></html>`;
};
