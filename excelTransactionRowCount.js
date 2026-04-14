import XLSX from "xlsx";

function rowText(row) {
  if (!Array.isArray(row)) {
    return "";
  }
  return row.map((c) => String(c ?? "").toLowerCase()).join(" ");
}

export function countRowsAfterBankStatementHeader(worksheet) {
  const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false });
  if (!Array.isArray(matrix) || matrix.length === 0) {
    return null;
  }

  let headerIdx = -1;
  for (let i = 0; i < matrix.length; i++) {
    const text = rowText(matrix[i]);
    const hasDateCol = text.includes("თარიღი");
    const hasDebitCredit = text.includes("დებეტი") || text.includes("კრედიტი");
    const hasOperationContent =
      (text.includes("ოპერაციის") && text.includes("შინაარსი")) ||
      text.includes("ოპერაციის შინაარსი");
    if (hasDateCol && (hasDebitCredit || hasOperationContent)) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    return null;
  }

  let emptyStreak = 0;
  let count = 0;
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const row = matrix[i];
    const nonEmpty =
      Array.isArray(row) && row.some((c) => String(c ?? "").trim() !== "");
    if (!nonEmpty) {
      emptyStreak += 1;
      if (emptyStreak >= 2) {
        break;
      }
      continue;
    }
    emptyStreak = 0;
    count += 1;
  }

  return count;
}
