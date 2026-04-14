import path from "node:path";
import { mkdir, readFile, writeFile as writeFileFs } from "node:fs/promises";
import fs from "node:fs";
import cron from "node-cron";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import XLSX from "xlsx";
import { createHash, randomUUID } from "node:crypto";
import { countRowsAfterBankStatementHeader } from "../excelTransactionRowCount.js";

const WATCHER_ENABLED = true;
const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
const CRON_EXPR = "0 * * * *";
const IMPORT_ACCOUNT_CODE = "1210.01";
const DEFAULT_ALLOWED_SENDER = "g.gagua@dwellup.io";
const DEFAULT_RECEIVER_EMAIL = "gegagagua@gmail.com";
const DEFAULT_RECEIVER_PASSWORD = "YOUR_GMAIL_APP_PASSWORD_HERE";
const DEFAULT_RECEIVER_OWNER_EMAIL = "info@book-wise.ge";
const MAX_TRACKED_UIDS = 3000;

let mailImportCycleRunning = false;

const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();

const normalizeSubjectCompany = (subject) =>
  String(subject ?? "")
    .replace(/^(re|fw|fwd)\s*:\s*/gi, "")
    .trim()
    .toLowerCase();

const toYyyyMmDd = (dateValue) => {
  const d = dateValue instanceof Date && !Number.isNaN(dateValue.getTime()) ? dateValue : new Date();
  return d.toISOString().slice(0, 10);
};

const sanitizeFileName = (name) =>
  String(name ?? "statement.xlsx")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim()
    .slice(0, 180) || "statement.xlsx";

const isExcelAttachment = (filename = "", contentType = "") => {
  const lower = String(filename).toLowerCase();
  const type = String(contentType).toLowerCase();
  return (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    lower.endsWith(".csv") ||
    type.includes("spreadsheetml") ||
    type.includes("ms-excel") ||
    type.includes("csv")
  );
};

const loadState = async (stateFilePath) => {
  try {
    if (!fs.existsSync(stateFilePath)) {
      return { processedKeys: [] };
    }
    const raw = await readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.processedKeys)) {
      return { processedKeys: [] };
    }
    return { processedKeys: parsed.processedKeys.map((v) => String(v)).filter((v) => v.length > 0) };
  } catch {
    return { processedKeys: [] };
  }
};

const saveState = async (stateFilePath, processedKeysSet) => {
  const processedKeys = Array.from(processedKeysSet).slice(-MAX_TRACKED_UIDS);
  await writeFileFs(stateFilePath, JSON.stringify({ processedKeys }, null, 2), "utf8");
};

const countExcelRows = (buffer) => {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) {
    return 0;
  }
  const sheet = workbook.Sheets[firstSheet];
  const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const byHeaderCount = countRowsAfterBankStatementHeader(sheet);
  return byHeaderCount ?? jsonRows.length;
};

const stateKeyForMessage = (userId, receiverEmail, uid) =>
  `${String(userId)}|${normalizeEmail(receiverEmail)}|${String(uid)}`;

const processMailboxForUser = async ({
  db,
  user,
  receiverEmail,
  receiverPassword,
  companyBySubject,
  processed,
  uploadsDir,
  importsOut,
}) => {
  if (!receiverEmail || !receiverPassword) {
    return;
  }
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: receiverEmail, pass: receiverPassword },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      for await (const msg of client.fetch({ seen: false }, { uid: true, source: true })) {
        const msgKey = stateKeyForMessage(user.id, receiverEmail, msg.uid);
        if (processed.has(msgKey)) {
          continue;
        }
        const parsed = await simpleParser(msg.source);
        const senderEmail = normalizeEmail(parsed.from?.value?.[0]?.address ?? "");
        const companyNameKey = normalizeSubjectCompany(parsed.subject);
        const candidate = companyBySubject.get(companyNameKey);
        if (!candidate || senderEmail !== candidate.sender) {
          processed.add(msgKey);
          continue;
        }
        let importedAny = false;
        for (const att of parsed.attachments ?? []) {
          if (!att?.content || !isExcelAttachment(att.filename, att.contentType)) {
            continue;
          }
          const contentSha256 = createHash("sha256").update(att.content).digest("hex");
          const dup = await db.get(
            `SELECT id FROM company_excel_uploads WHERE companyId = ? AND contentSha256 = ? LIMIT 1`,
            [candidate.id, contentSha256],
          );
          if (dup?.id) {
            console.log("[mail-import] skip duplicate attachment", {
              companyId: candidate.id,
              fileName: sanitizeFileName(att.filename || "statement.xlsx"),
              contentSha256,
            });
            continue;
          }
          const fileName = sanitizeFileName(att.filename || `statement-${Date.now()}.xlsx`);
          const ext = path.extname(fileName) || ".xlsx";
          const storedFileName = `${Date.now()}-${randomUUID()}${ext}`;
          const fullPath = path.join(uploadsDir, storedFileName);
          await writeFileFs(fullPath, att.content);
          let totalRows = 0;
          try {
            totalRows = countExcelRows(att.content);
          } catch {
            totalRows = 0;
          }
          await db.run(
            `INSERT INTO company_excel_uploads (companyId, reportDate, fileName, storedFileName, accountCode, totalRows, inserted, updated, skipped, contentSha256)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              candidate.id,
              toYyyyMmDd(parsed.date),
              fileName,
              storedFileName,
              IMPORT_ACCOUNT_CODE,
              totalRows,
              0,
              0,
              0,
              contentSha256,
            ],
          );
          importedAny = true;
          importsOut?.push({
            companyId: candidate.id,
            companyName: candidate.name,
            fileName,
            totalRows,
          });
          console.log("[mail-import] statement uploaded", {
            ownerUserId: user.id,
            receiverEmail,
            companyId: candidate.id,
            company: candidate.name,
            senderEmail,
            fileName,
            totalRows,
          });
        }
        await client.messageFlagsAdd(msg.uid, ["\\Seen"]);
        processed.add(msgKey);
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (error) {
    console.error("[mail-import] failed for receiver", { userId: user.id, receiverEmail, error });
    try {
      await client.logout();
    } catch {}
  }
};

export const runMailImportOnce = async ({ dbPromise, uploadsDir, dataDir }) => {
  const stateFilePath = path.join(dataDir, "mail-import-state.json");
  if (mailImportCycleRunning) {
    return { ok: false, skipped: true, message: "already_running", imported: [] };
  }
  mailImportCycleRunning = true;
  const imported = [];
  try {
    const state = await loadState(stateFilePath);
    const processed = new Set(state.processedKeys);
    await mkdir(uploadsDir, { recursive: true });
    await mkdir(path.dirname(stateFilePath), { recursive: true });
    const db = await dbPromise;
    const users = await db.all(
      `SELECT id, email, role, mailImportReceiverEmail, mailImportReceiverPassword
       FROM users
       WHERE role = 'admin' OR (mailImportReceiverEmail IS NOT NULL AND mailImportReceiverPassword IS NOT NULL)`,
    );
    for (const user of users) {
      const companies =
        user.role === "admin"
          ? await db.all(
              `SELECT id, name, inactive, settingsJson
               FROM companies
               WHERE inactive = 0`,
            )
          : await db.all(
              `SELECT id, name, inactive, settingsJson
               FROM companies
               WHERE ownerUserId = ? AND inactive = 0`,
              [user.id],
            );
      if (!companies.length) {
        continue;
      }
      const companyBySubject = new Map();
      for (const company of companies) {
        const settings = (() => {
          try {
            return company.settingsJson ? JSON.parse(company.settingsJson) : {};
          } catch {
            return {};
          }
        })();
        const sender = normalizeEmail(settings?.automation?.mailImportSender ?? DEFAULT_ALLOWED_SENDER);
        const subjectKey = normalizeSubjectCompany(company.name);
        if (subjectKey) {
          companyBySubject.set(subjectKey, {
            id: company.id,
            name: company.name,
            sender,
          });
        }
      }
      const receiverEmail = normalizeEmail(
        user.mailImportReceiverEmail ||
          (normalizeEmail(user.email) === DEFAULT_RECEIVER_OWNER_EMAIL ? DEFAULT_RECEIVER_EMAIL : ""),
      );
      const receiverPassword = String(
        user.mailImportReceiverPassword ||
          (normalizeEmail(user.email) === DEFAULT_RECEIVER_OWNER_EMAIL ? DEFAULT_RECEIVER_PASSWORD : ""),
      ).trim();
      await processMailboxForUser({
        db,
        user,
        receiverEmail,
        receiverPassword,
        companyBySubject,
        processed,
        uploadsDir,
        importsOut: imported,
      });
    }
    await saveState(stateFilePath, processed);
    return { ok: true, imported };
  } catch (error) {
    console.error("[mail-import] failed", error);
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unknown error",
      imported,
    };
  } finally {
    mailImportCycleRunning = false;
  }
};

export const startEmailStatementImportWatcher = ({ dbPromise, uploadsDir, dataDir }) => {
  if (!WATCHER_ENABLED) {
    console.log("[mail-import] disabled");
    return;
  }

  const ctx = { dbPromise, uploadsDir, dataDir };
  console.log(`[mail-import] enabled: schedule=${CRON_EXPR}`);
  void runMailImportOnce(ctx);
  cron.schedule(CRON_EXPR, () => {
    void runMailImportOnce(ctx);
  });
};
