import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import multer from "multer";
import XLSX from "xlsx";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { profile } from "./config/index.js";
import { dbPromise, initializeDb } from "./db.js";
import { runBalanceWorkflow } from "./playwright/balanceClient.js";
import { countRowsAfterBankStatementHeader } from "./excelTransactionRowCount.js";
import { sendDirectTransactionalSms } from "./services/directSmsSend.js";
import {
  sendBalanceNotifyProbeEmail,
  sendBalanceRunEmailNotification,
} from "./services/resendBalanceNotify.js";
import { recordBalanceImportRun } from "./services/balanceImportRunLog.js";
import {
  runMailImportOnce,
  startEmailStatementImportWatcher,
} from "./services/emailStatementImportWatcher.js";
import { sendOtp, verifyCode, getSmsSetupIssue } from "./services/smsToVerify.js";
import {
  mergeCompanySettingsPatch,
  parseCompanySettings,
} from "./services/companySettings.js";
import { getBalanceRulesDocumentation } from "./playwright/balanceRulesDocumentation.js";

const app = express();
const port = Number(process.env.PORT) || 4000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, "data", "uploads");
const resultsDir = path.join(__dirname, "data", "run-results");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});
const ALLOWED_BANKS = ["TBC", "BOG", "LIBERTY", "TERABANK", "PROCREDIT", "CREDO"];

const pendingLogins = new Map();
const PENDING_LOGIN_TTL_MS = 12 * 60 * 1000;
const PENDING_SMS_BLOCKED_MARKER = "__sms_to_blocked__";
const LOGIN_OTP_BYPASS_EMAIL = "info@book-wise.ge";

const randomFiveDigitCode = () => String(Math.floor(10_000 + Math.random() * 90_000));

const accountPhoneForSms = (value) => {
  const s = String(value ?? "").trim();
  return s.length > 0 ? s : "";
};

const otpCodesEqual = (expected, provided) => {
  const a = String(expected ?? "").replace(/\D/g, "");
  const b = String(provided ?? "").replace(/\D/g, "");
  if (a.length !== 5 || b.length !== 5) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
};

const isSmsDevBypass = () => process.env.SMSTO_DEV_BYPASS === "1";

const sweepPendingLogins = () => {
  const now = Date.now();
  for (const [key, entry] of pendingLogins.entries()) {
    if (entry.expiresAt < now) {
      pendingLogins.delete(key);
    }
  }
};

setInterval(sweepPendingLogins, 60_000);

const authTokenHeader = "x-auth-token";
const authSessionCookie = "bookwise_session";

const attachSessionCookie = (res, token) => {
  res.cookie(authSessionCookie, token, {
    httpOnly: true,
    secure: profile === "prod",
    sameSite: "lax",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
};

const clearSessionCookie = (res) => {
  res.clearCookie(authSessionCookie, {
    path: "/",
    sameSite: "lax",
    secure: profile === "prod",
  });
};

const getAuthTokenFromRequest = (req) => {
  const headerToken = req.headers?.[authTokenHeader];
  if (typeof headerToken === "string" && headerToken.trim().length > 0) {
    return headerToken.trim();
  }
  if (Array.isArray(headerToken) && headerToken[0]?.trim()) {
    return headerToken[0].trim();
  }

  const authz = req.headers?.authorization;
  if (typeof authz === "string") {
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]?.trim()) {
      return m[1].trim();
    }
  }

  const cookieToken = req.cookies?.[authSessionCookie];
  if (typeof cookieToken === "string" && cookieToken.trim().length > 0) {
    return cookieToken.trim();
  }

  const queryToken = req.query?.token;
  if (typeof queryToken === "string" && queryToken.trim().length > 0) {
    return queryToken.trim();
  }

  return "";
};

const getCompanyScopeWhere = (user) =>
  user?.role === "admin" ? "1=1" : "ownerUserId = ?";

const getCompanyScopeParams = (user) =>
  user?.role === "admin" ? [] : [user.id];

const companyRowToClient = (row, includeSettings = false) => {
  if (!row) {
    return row;
  }
  const { settingsJson, ...rest } = row;
  const base = {
    ...rest,
    inactive: Number(row.inactive ?? 0) === 1,
  };
  if (includeSettings) {
    return {
      ...base,
      settings: parseCompanySettings(settingsJson, row.bank),
    };
  }
  return base;
};

const getCompanyForUser = async (db, companyId, user) => {
  return db.get(
    `SELECT id, email, name, bank, balancePassword, phone, ownerUserId, inactive, settingsJson
     FROM companies
     WHERE id = ? AND ${getCompanyScopeWhere(user)}`,
    [companyId, ...getCompanyScopeParams(user)],
  );
};

app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

const applyNoCacheHeaders = (res) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, private, max-age=0, s-maxage=0",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
};

app.use("/api", (_req, res, next) => {
  applyNoCacheHeaders(res);
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/automation/balance/run", async (_req, res) => {
  return res.status(400).json({
    message: "Use /api/companies/:companyId/imports/:importId/run endpoint.",
  });
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  const password = String(req.body?.password ?? "");

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  const db = await dbPromise;
  const user = await db.get(
    `SELECT id, email, role, phone
     FROM users
     WHERE LOWER(email) = LOWER(?) AND password = ?`,
    [email, password],
  );

  if (!user) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  if (String(user.email).toLowerCase() === LOGIN_OTP_BYPASS_EMAIL) {
    const token = randomUUID();
    await db.run(
      `UPDATE users
       SET sessionToken = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [token, user.id],
    );
    attachSessionCookie(res, token);
    return res.json({
      ok: true,
      otpSkipped: true,
      token,
      user: { email: user.email, role: user.role },
    });
  }

  sweepPendingLogins();
  const pendingToken = randomUUID();
  const otpPhone = accountPhoneForSms(user.phone);
  const useAutoOtp = otpPhone.length > 0;

  const entry = {
    userId: user.id,
    email: user.email,
    role: user.role,
    expiresAt: Date.now() + PENDING_LOGIN_TTL_MS,
    verificationId: null,
    localOtpCode: null,
  };

  let smsAutoSent = false;
  if (useAutoOtp) {
    const code = randomFiveDigitCode();
    entry.localOtpCode = code;
    const smsText = `Bookwise: ${code}`;
    const sent = await sendDirectTransactionalSms(otpPhone, smsText);
    smsAutoSent = true;
    if (!sent.ok && process.env.SMSTO_DEBUG === "1") {
      console.error("[login] auto OTP SMS failed", sent.status, sent.detail);
    }
  }

  pendingLogins.set(pendingToken, entry);

  return res.json({
    ok: true,
    pendingToken,
    user: { email: user.email, role: user.role },
    smsAutoSent,
  });
});

app.post("/api/auth/sms/send", async (req, res) => {
  sweepPendingLogins();
  const pendingToken = String(req.body?.pendingToken ?? "").trim();
  const phone = String(req.body?.phone ?? "").trim();
  const entry = pendingLogins.get(pendingToken);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(401).json({ message: "Session expired. Log in again." });
  }
  if (entry.localOtpCode) {
    return res.status(400).json({ message: "OTP was already sent for this session." });
  }
  if (isSmsDevBypass()) {
    return res.json({ ok: true, devMode: true });
  }
  const setupIssue = getSmsSetupIssue();
  if (setupIssue) {
    return res.status(503).json({
      message: setupIssue.message,
    });
  }
  const result = await sendOtp(phone);
  if (!result.success && process.env.SMSTO_DEBUG === "1") {
    console.error("[sms] sendOtp failed", result.httpCode, result.response?.slice?.(0, 500));
  }
  if (result.blocked && result.success) {
    entry.verificationId = PENDING_SMS_BLOCKED_MARKER;
    return res.json({ ok: true, blocked: true });
  }
  if (!result.success || !result.verificationId) {
    return res.status(502).json({
      message: "Could not send SMS",
      detail: typeof result.response === "string" ? result.response.slice(0, 300) : "",
    });
  }
  entry.verificationId = result.verificationId;
  return res.json({ ok: true });
});

app.post("/api/auth/sms/verify", async (req, res) => {
  sweepPendingLogins();
  const pendingToken = String(req.body?.pendingToken ?? "").trim();
  const code = String(req.body?.code ?? "").trim();
  const entry = pendingLogins.get(pendingToken);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(401).json({ message: "Session expired. Log in again." });
  }

  const devBypass = isSmsDevBypass() && code === "11111";
  let verified = false;
  if (devBypass) {
    verified = true;
  } else if (entry.verificationId === PENDING_SMS_BLOCKED_MARKER) {
    verified = true;
  } else if (entry.localOtpCode) {
    verified = otpCodesEqual(entry.localOtpCode, code);
  } else {
    if (!entry.verificationId) {
      return res.status(400).json({ message: "Request an SMS code first." });
    }
    const check = await verifyCode(entry.verificationId, code);
    verified = check.success;
  }

  if (!verified) {
    return res.status(401).json({ message: "Invalid verification code." });
  }

  const db = await dbPromise;
  const token = randomUUID();
  await db.run(
    `UPDATE users
     SET sessionToken = ?, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [token, entry.userId],
  );
  pendingLogins.delete(pendingToken);

  attachSessionCookie(res, token);
  return res.json({
    ok: true,
    token,
    user: { email: entry.email, role: entry.role },
  });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = getAuthTokenFromRequest(req);
  clearSessionCookie(res);
  if (token) {
    const db = await dbPromise;
    await db.run(
      `UPDATE users
       SET sessionToken = NULL, updatedAt = CURRENT_TIMESTAMP
       WHERE sessionToken = ?`,
      [token],
    );
  }
  return res.status(204).send();
});

app.use("/api", async (req, res, next) => {
  const token = getAuthTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const db = await dbPromise;
  const user = await db.get(
    `SELECT id, email, role, phone
     FROM users
     WHERE sessionToken = ?`,
    [token],
  );
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  req.authUser = user;
  return next();
});

app.post("/api/me/balance-notify-test", async (req, res) => {
  try {
    const db = await dbPromise;
    const notifyUserRow = await db.get(`SELECT email FROM users WHERE id = ?`, [req.authUser.id]);
    const notifyToEmail = String(notifyUserRow?.email ?? req.authUser?.email ?? "").trim();
    const result = await sendBalanceNotifyProbeEmail(notifyToEmail || undefined);
    return res.json(result);
  } catch (err) {
    console.error("[resend] balance-notify-test failed", err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/api/automation/balance-rules-spec", (_req, res) => {
  res.json(getBalanceRulesDocumentation());
});

app.post("/api/automation/mail-import/run-once", async (_req, res) => {
  if (profile === "prod") {
    return res.status(403).json({ message: "Not available in production" });
  }
  const result = await runMailImportOnce({
    dbPromise,
    uploadsDir,
    dataDir: path.join(__dirname, "data"),
  });
  if (result.skipped) {
    return res.status(409).json(result);
  }
  if (!result.ok) {
    return res.status(500).json(result);
  }
  return res.json(result);
});

app.get("/api/companies", async (req, res) => {
  const db = await dbPromise;
  const companies = await db.all(
    `SELECT id, email, name, bank, balancePassword, phone, inactive
     FROM companies
     WHERE ${getCompanyScopeWhere(req.authUser)}
     ORDER BY id DESC`,
    getCompanyScopeParams(req.authUser),
  );
  res.json(companies.map((row) => companyRowToClient(row)));
});

app.get("/api/companies/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ message: "Invalid company id" });
  }

  const db = await dbPromise;
  const company = await getCompanyForUser(db, id, req.authUser);

  if (!company) {
    return res.status(404).json({ message: "Company not found" });
  }

  return res.json(companyRowToClient(company, true));
});

app.patch("/api/companies/:id/settings", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ message: "Invalid company id" });
  }

  const db = await dbPromise;
  const company = await getCompanyForUser(db, id, req.authUser);
  if (!company) {
    return res.status(404).json({ message: "Company not found" });
  }

  const current = parseCompanySettings(company.settingsJson, company.bank);
  const next = mergeCompanySettingsPatch(current, req.body ?? {});
  await db.run(
    `UPDATE companies
     SET settingsJson = ?, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(next), id],
  );

  const updated = await getCompanyForUser(db, id, req.authUser);
  return res.json({
    settings: parseCompanySettings(updated.settingsJson, updated.bank),
  });
});

app.post("/api/companies/:id/settings/accounting/test-connection", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ message: "Invalid company id" });
  }

  const db = await dbPromise;
  const company = await getCompanyForUser(db, id, req.authUser);
  if (!company) {
    return res.status(404).json({ message: "Company not found" });
  }

  const current = parseCompanySettings(company.settingsJson, company.bank);
  const checkedAt = new Date().toISOString();
  const next = mergeCompanySettingsPatch(current, {
    accounting: {
      ...current.accounting,
      connected: true,
      lastSyncAt: checkedAt,
    },
  });
  await db.run(
    `UPDATE companies
     SET settingsJson = ?, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(next), id],
  );

  const updated = await getCompanyForUser(db, id, req.authUser);
  return res.json({
    ok: true,
    checkedAt,
    message: "Connection successful (simulated).",
    settings: parseCompanySettings(updated.settingsJson, updated.bank),
  });
});

app.post("/api/companies/:id/settings/accounting/credentials", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ message: "Invalid company id" });
  }

  const username = String(req.body?.username ?? "").trim().slice(0, 255);
  if (!username) {
    return res.status(400).json({ message: "Username is required" });
  }

  const db = await dbPromise;
  const company = await getCompanyForUser(db, id, req.authUser);
  if (!company) {
    return res.status(404).json({ message: "Company not found" });
  }

  const hasPassword = typeof req.body?.password === "string" && req.body.password.length > 0;
  const current = parseCompanySettings(company.settingsJson, company.bank);
  const next = mergeCompanySettingsPatch(current, {
    accounting: {
      ...current.accounting,
      username,
      hasCredentials: hasPassword,
    },
  });
  await db.run(
    `UPDATE companies
     SET settingsJson = ?, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(next), id],
  );

  const updated = await getCompanyForUser(db, id, req.authUser);
  return res.json({
    ok: true,
    settings: parseCompanySettings(updated.settingsJson, updated.bank),
  });
});

app.get("/api/companies/:id/imports", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ message: "Invalid company id" });
  }

  const db = await dbPromise;
  const company = await getCompanyForUser(db, id, req.authUser);
  if (!company) {
    return res.status(404).json({ message: "Company not found" });
  }

  const rows = await db.all(
    `SELECT id, companyId, reportDate, fileName, storedFileName, accountCode, runStatus, runMessage, runAnalyticsJson, resultScreenshotFileName, lastRunAt, totalRows, inserted, updated, skipped, createdAt
     FROM company_excel_uploads
     WHERE companyId = ?
     ORDER BY reportDate DESC, id DESC`,
    [id],
  );
  return res.json(rows);
});

app.get("/api/companies/:companyId/imports/:importId/download", async (req, res) => {
  const companyId = Number(req.params.companyId);
  const importId = Number(req.params.importId);
  if (!companyId || !importId) {
    return res.status(400).json({ message: "Invalid companyId or importId" });
  }

  const db = await dbPromise;
  const company = await getCompanyForUser(db, companyId, req.authUser);
  if (!company) {
    return res.status(404).json({ message: "Company not found" });
  }

  const uploadEntry = await db.get(
    `SELECT fileName, storedFileName
     FROM company_excel_uploads
     WHERE id = ? AND companyId = ?`,
    [importId, companyId],
  );

  if (!uploadEntry?.storedFileName) {
    return res.status(404).json({ message: "Uploaded file not found" });
  }

  const filePath = path.join(uploadsDir, uploadEntry.storedFileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: "Stored file does not exist on server" });
  }

  return res.download(filePath, uploadEntry.fileName);
});

app.get("/api/companies/:companyId/imports/:importId/result-screenshot", async (req, res) => {
  const companyId = Number(req.params.companyId);
  const importId = Number(req.params.importId);
  if (!companyId || !importId) {
    return res.status(400).json({ message: "Invalid companyId or importId" });
  }

  const db = await dbPromise;
  const company = await getCompanyForUser(db, companyId, req.authUser);
  if (!company) {
    return res.status(404).json({ message: "Company not found" });
  }

  const uploadEntry = await db.get(
    `SELECT resultScreenshotFileName
     FROM company_excel_uploads
     WHERE id = ? AND companyId = ?`,
    [importId, companyId],
  );

  if (!uploadEntry?.resultScreenshotFileName) {
    return res.status(404).json({ message: "Result screenshot not found" });
  }

  const screenshotPath = path.join(resultsDir, uploadEntry.resultScreenshotFileName);
  if (!fs.existsSync(screenshotPath)) {
    return res.status(404).json({ message: "Stored screenshot does not exist on server" });
  }

  return res.sendFile(screenshotPath);
});

app.get("/api/companies/:companyId/imports/:importId/row-outcomes", async (req, res) => {
  const companyId = Number(req.params.companyId);
  const importId = Number(req.params.importId);
  if (!companyId || !importId) {
    return res.status(400).json({ message: "Invalid companyId or importId" });
  }

  const db = await dbPromise;
  const company = await getCompanyForUser(db, companyId, req.authUser);
  if (!company) {
    return res.status(404).json({ message: "Company not found" });
  }

  const uploadEntry = await db.get(
    `SELECT id FROM company_excel_uploads WHERE id = ? AND companyId = ?`,
    [importId, companyId],
  );
  if (!uploadEntry?.id) {
    return res.status(404).json({ message: "Import not found" });
  }

  const rows = await db.all(
    `SELECT id, rowIndex, rowKey, outcome, message, warning, objectName, transactionType, amountText, detailJson, createdAt
     FROM balance_import_row_outcomes
     WHERE importId = ?
     ORDER BY rowIndex ASC`,
    [importId],
  );
  return res.json({ outcomes: rows });
});

app.delete("/api/companies/:companyId/imports/:importId", async (req, res) => {
  const companyId = Number(req.params.companyId);
  const importId = Number(req.params.importId);
  if (!companyId || !importId) {
    return res.status(400).json({ message: "Invalid companyId or importId" });
  }

  const db = await dbPromise;
  const company = await getCompanyForUser(db, companyId, req.authUser);
  if (!company) {
    return res.status(404).json({ message: "Company not found" });
  }

  const uploadEntry = await db.get(
    `SELECT id, storedFileName, resultScreenshotFileName
     FROM company_excel_uploads
     WHERE id = ? AND companyId = ?`,
    [importId, companyId],
  );
  if (!uploadEntry?.id) {
    return res.status(404).json({ message: "Import not found" });
  }

  await db.run("DELETE FROM company_excel_uploads WHERE id = ? AND companyId = ?", [importId, companyId]);

  if (uploadEntry.storedFileName) {
    const filePath = path.join(uploadsDir, uploadEntry.storedFileName);
    if (fs.existsSync(filePath)) {
      await unlink(filePath).catch(() => undefined);
    }
  }
  if (uploadEntry.resultScreenshotFileName) {
    const screenshotPath = path.join(resultsDir, uploadEntry.resultScreenshotFileName);
    if (fs.existsSync(screenshotPath)) {
      await unlink(screenshotPath).catch(() => undefined);
    }
  }

  return res.status(204).send();
});

app.post("/api/companies/:companyId/imports/:importId/run", async (req, res) => {
  const companyId = Number(req.params.companyId);
  const importId = Number(req.params.importId);
  if (!companyId || !importId) {
    return res.status(400).json({ message: "Invalid companyId or importId" });
  }

  const db = await dbPromise;
  const company = await getCompanyForUser(db, companyId, req.authUser);
  if (!company) {
    return res.status(404).json({ message: "Company not found" });
  }

  const uploadEntry = await db.get(
    `SELECT id, fileName, storedFileName, accountCode, totalRows
     FROM company_excel_uploads
     WHERE id = ? AND companyId = ?`,
    [importId, companyId],
  );
  if (!uploadEntry?.storedFileName) {
    return res.status(404).json({ message: "Uploaded file not found" });
  }

  const filePath = path.join(uploadsDir, uploadEntry.storedFileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: "Stored file does not exist on server" });
  }

  const notifyUserRow = await db.get(`SELECT email FROM users WHERE id = ?`, [req.authUser.id]);
  const notifyToEmail = String(notifyUserRow?.email ?? req.authUser?.email ?? "").trim();

  const debugMode = req.body?.debugMode === true;
  const slowMoMs = Number(req.body?.slowMoMs);
  const accountCodeOverride =
    typeof req.body?.accountCode === "string" && req.body.accountCode.trim().length > 0
      ? req.body.accountCode.trim()
      : undefined;
  const balanceCardTitle = String(company.name ?? "").trim();
  if (!balanceCardTitle) {
    return res.status(400).json({
      message: "Company name is required for Balance: it must match the MyDatabase card title.",
    });
  }
  await mkdir(resultsDir, { recursive: true });
  const resultFileBase = `${Date.now()}-${randomUUID()}-company-${companyId}-import-${importId}`;
  const successScreenshotFileName = `${resultFileBase}-success.png`;
  const failureScreenshotFileName = `${resultFileBase}-fail.png`;
  const successScreenshotPath = path.join(resultsDir, successScreenshotFileName);
  const failureScreenshotPath = path.join(resultsDir, failureScreenshotFileName);

  const runStartedMs = Date.now();

  try {
    const result = await runBalanceWorkflow({
      loginEmail: company.email,
      loginPassword: company.balancePassword,
      companyName: balanceCardTitle,
      filePath,
      accountCode: uploadEntry.accountCode || accountCodeOverride,
      successScreenshotPath,
      failureScreenshotPath,
      headless: debugMode ? false : true,
      slowMo: Number.isNaN(slowMoMs) ? undefined : slowMoMs,
    });
    await db.run(`DELETE FROM balance_import_row_outcomes WHERE importId = ?`, [importId]);
    for (const row of result.rowOutcomes || []) {
      await db.run(
        `INSERT INTO balance_import_row_outcomes (importId, rowIndex, rowKey, outcome, message, warning, objectName, transactionType, amountText, detailJson)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          importId,
          row.rowIndex,
          row.rowKey || null,
          row.outcome,
          row.message || null,
          row.warning || null,
          row.objectName || null,
          row.transactionType || null,
          row.amountText || null,
          row.detailJson || null,
        ],
      );
    }
    const analyticsPayload =
      result.analytics &&
      JSON.stringify({
        ...result.analytics,
        rowOutcomeSummary: result.rowOutcomeSummary ?? null,
      });
    await db.run(
      `UPDATE company_excel_uploads
       SET runStatus = ?, runMessage = ?, runAnalyticsJson = ?, resultScreenshotFileName = ?, lastRunAt = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        "success",
        result.message ?? "Run completed successfully.",
        analyticsPayload,
        successScreenshotFileName,
        importId,
      ],
    );
    const processingSeconds = (Date.now() - runStartedMs) / 1000;
    let runLog = null;
    try {
      runLog = await recordBalanceImportRun(db, {
        companyId,
        importId,
        runStatus: "success",
        rowOutcomeSummary: result.rowOutcomeSummary,
        rowOutcomes: result.rowOutcomes,
        processingSeconds,
        workflowError: null,
      });
    } catch (logErr) {
      console.error("[balance-import-run] insert failed (success path)", logErr);
    }
    let emailNotification = { ok: false };
    try {
      emailNotification = await sendBalanceRunEmailNotification({
        status: "success",
        company,
        importRecord: {
          id: importId,
          fileName: uploadEntry.fileName,
          accountCode: uploadEntry.accountCode || accountCodeOverride || "",
          totalRows: uploadEntry.totalRows,
        },
        result,
        runLog,
        notifyTo: notifyToEmail || undefined,
      });
    } catch (notifyErr) {
      emailNotification = { ok: false, error: String(notifyErr) };
      console.error("[resend] send threw (success path)", notifyErr);
    }
    return res.json({ ...result, emailNotification });
  } catch (error) {
    const processingSeconds = (Date.now() - runStartedMs) / 1000;
    await db.run(
      `UPDATE company_excel_uploads
       SET runStatus = ?, runMessage = ?, runAnalyticsJson = ?, resultScreenshotFileName = ?, lastRunAt = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        "failed",
        error instanceof Error ? error.message : "Unknown error",
        null,
        failureScreenshotFileName,
        importId,
      ],
    );
    let runLog = null;
    try {
      runLog = await recordBalanceImportRun(db, {
        companyId,
        importId,
        runStatus: "failed",
        rowOutcomeSummary: null,
        rowOutcomes: [],
        processingSeconds,
        workflowError: error,
      });
    } catch (logErr) {
      console.error("[balance-import-run] insert failed (failure path)", logErr);
    }
    let emailNotification = { ok: false };
    try {
      emailNotification = await sendBalanceRunEmailNotification({
        status: "failed",
        company,
        importRecord: {
          id: importId,
          fileName: uploadEntry.fileName,
          accountCode: uploadEntry.accountCode || accountCodeOverride || "",
          totalRows: uploadEntry.totalRows,
        },
        error,
        runLog,
        notifyTo: notifyToEmail || undefined,
      });
    } catch (notifyErr) {
      emailNotification = { ok: false, error: String(notifyErr) };
      console.error("[resend] send threw (failure path)", notifyErr);
    }
    return res.status(500).json({
      message: "Balance automation failed",
      error: error instanceof Error ? error.message : "Unknown error",
      emailNotification,
    });
  }
});

const normalizeBank = (value) => {
  if (!value) {
    return null;
  }

  const bank = String(value).trim();
  const normalized = bank.toLowerCase();
  const bankAliasMap = {
    tbc: "TBC",
    bog: "BOG",
    liberty: "LIBERTY",
    "ლიბერთი": "LIBERTY",
    terabank: "TERABANK",
    "ტერაბანკი": "TERABANK",
    procredit: "PROCREDIT",
    "პროკრედიტი": "PROCREDIT",
    credo: "CREDO",
    "კრედო": "CREDO",
  };
  const mapped = bankAliasMap[normalized];
  return mapped && ALLOWED_BANKS.includes(mapped) ? mapped : null;
};

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? "").trim());

const ensureUserMailImportColumns = async (db) => {
  const rows = await db.all(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME IN ('mailImportReceiverEmail', 'mailImportReceiverPassword')`,
  );
  const existing = new Set(rows.map((row) => String(row.COLUMN_NAME)));
  if (!existing.has("mailImportReceiverEmail")) {
    await db.exec("ALTER TABLE users ADD COLUMN mailImportReceiverEmail VARCHAR(255) NULL");
  }
  if (!existing.has("mailImportReceiverPassword")) {
    await db.exec("ALTER TABLE users ADD COLUMN mailImportReceiverPassword VARCHAR(255) NULL");
  }
};

app.post("/api/companies/import", upload.single("file"), async (req, res) => {
  try {
    const companyId = Number(req.body?.companyId);
    const reportDate = String(req.body?.reportDate ?? "").trim();
    const accountCode = String(req.body?.accountCode ?? "").trim() || "1210.01";

    if (!companyId || !reportDate) {
      return res.status(400).json({ message: "companyId and reportDate are required" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      return res.status(400).json({ message: "reportDate must be YYYY-MM-DD" });
    }

    if (!req.file?.buffer) {
      return res.status(400).json({ message: "File is required" });
    }

    await mkdir(uploadsDir, { recursive: true });
    const extension = path.extname(req.file.originalname || "");
    const storedFileName = `${Date.now()}-${randomUUID()}${extension || ".xlsx"}`;
    await writeFile(path.join(uploadsDir, storedFileName), req.file.buffer);

    let rows = [];
    let reportedTotalRows = 0;
    try {
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const firstSheet = workbook.SheetNames[0];
      if (!firstSheet) {
        return res.status(400).json({ message: "Uploaded file has no sheets" });
      }

      const sheet = workbook.Sheets[firstSheet];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const bankTableRowCount = countRowsAfterBankStatementHeader(sheet);
      reportedTotalRows = bankTableRowCount ?? rows.length;
    } catch {
      return res.status(400).json({ message: "Could not parse Excel file" });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "No rows found in uploaded file" });
    }

    const db = await dbPromise;
    const company = await getCompanyForUser(db, companyId, req.authUser);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const normalized = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [String(key).trim().toLowerCase(), value]),
      );

      const email = String(normalized.email ?? "").trim();
      const name = String(normalized.name ?? "").trim();
      const rowBank = normalizeBank(normalized.bank);
      const bank =
        rowBank ?? (ALLOWED_BANKS.includes(company.bank) ? company.bank : null);
      const balancePassword = String(
        normalized.balancepassword ?? normalized["balance password"] ?? "",
      ).trim();

      if (!email || !name || !bank || !balancePassword) {
        skipped += 1;
        continue;
      }

      const existing = await db.get("SELECT id FROM companies WHERE email = ?", [email]);
      if (existing?.id) {
        const accessibleExisting = await getCompanyForUser(db, existing.id, req.authUser);
        if (!accessibleExisting) {
          skipped += 1;
          continue;
        }

        await db.run(
          `UPDATE companies
           SET name = ?, bank = ?, balancePassword = ?, updatedAt = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [name, bank, balancePassword, existing.id],
        );
        updated += 1;
        continue;
      }

      await db.run(
        `INSERT INTO companies (email, name, bank, balancePassword, ownerUserId)
         VALUES (?, ?, ?, ?, ?)`,
        [email, name, bank, balancePassword, req.authUser.id],
      );
      inserted += 1;
    }

    await db.run(
      `INSERT INTO company_excel_uploads (companyId, reportDate, fileName, storedFileName, accountCode, totalRows, inserted, updated, skipped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        reportDate,
        req.file.originalname || "uploaded-file",
        storedFileName,
        accountCode,
        reportedTotalRows,
        inserted,
        updated,
        skipped,
      ],
    );

    return res.json({
      inserted,
      updated,
      skipped,
      total: reportedTotalRows,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Upload failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/companies", async (req, res) => {
  const { email, name, bank, balancePassword, phone } = req.body ?? {};
  const phoneTrim = typeof phone === "string" ? phone.trim() : "";
  const phoneValue = phoneTrim.length > 0 ? phoneTrim.slice(0, 32) : null;

  if (!email || !name || !balancePassword || !ALLOWED_BANKS.includes(bank)) {
    return res.status(400).json({ message: "Invalid company payload" });
  }

  const db = await dbPromise;
  const result = await db.run(
    `INSERT INTO companies (email, name, bank, balancePassword, phone, ownerUserId)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [email, name, bank, balancePassword, phoneValue, req.authUser.id],
  );

  const created = await getCompanyForUser(db, result.lastID, req.authUser);

  return res.status(201).json(companyRowToClient(created, true));
});

app.put("/api/companies/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { email, name, bank, balancePassword, phone, inactive } = req.body ?? {};
  const phoneTrim = typeof phone === "string" ? phone.trim() : "";
  const phoneValue = phoneTrim.length > 0 ? phoneTrim.slice(0, 32) : null;
  const inactiveValue = inactive === true || inactive === 1 || inactive === "true" ? 1 : 0;

  if (!id || !email || !name || !balancePassword || !ALLOWED_BANKS.includes(bank)) {
    return res.status(400).json({ message: "Invalid company payload" });
  }

  const db = await dbPromise;
  const existing = await getCompanyForUser(db, id, req.authUser);

  if (!existing) {
    return res.status(404).json({ message: "Company not found" });
  }

  await db.run(
    `UPDATE companies
     SET email = ?, name = ?, bank = ?, balancePassword = ?, phone = ?, inactive = ?, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [email, name, bank, balancePassword, phoneValue, inactiveValue, id],
  );

  const updated = await getCompanyForUser(db, id, req.authUser);

  return res.json(companyRowToClient(updated, true));
});

app.delete("/api/companies/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ message: "Invalid company id" });
  }

  const db = await dbPromise;
  const existing = await getCompanyForUser(db, id, req.authUser);
  if (!existing) {
    return res.status(404).json({ message: "Company not found" });
  }

  await db.run("DELETE FROM company_excel_uploads WHERE companyId = ?", [id]);
  await db.run("DELETE FROM companies WHERE id = ?", [id]);

  return res.status(204).send();
});

app.get("/api/auth/me", async (req, res) => {
  const u = req.authUser;
  return res.json({
    email: u.email,
    phone: u.phone ?? null,
    role: u.role,
  });
});

const getMailImportSettingsHandler = async (req, res) => {
  const db = await dbPromise;
  try {
    await ensureUserMailImportColumns(db);
  } catch (error) {
    console.error("[mail-import-settings] ensure columns failed", error);
  }
  let user;
  try {
    user = await db.get(
      `SELECT id, email, mailImportReceiverEmail, mailImportReceiverPassword
       FROM users
       WHERE id = ?`,
      [req.authUser.id],
    );
  } catch (error) {
    if (error?.code === "ER_BAD_FIELD_ERROR") {
      user = await db.get(
        `SELECT id, email
         FROM users
         WHERE id = ?`,
        [req.authUser.id],
      );
    } else {
      throw error;
    }
  }
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }
  const companies = await db.all(
    `SELECT id, name, bank, settingsJson
     FROM companies
     WHERE ${getCompanyScopeWhere(req.authUser)}
     ORDER BY name ASC`,
    getCompanyScopeParams(req.authUser),
  );
  return res.json({
    user: {
      id: req.authUser.id,
      email: req.authUser.email,
      role: req.authUser.role,
    },
    receiverEmail: user.mailImportReceiverEmail ?? "",
    receiverPassword: user.mailImportReceiverPassword ?? "",
    companies: companies.map((company) => {
      const mergedSettings = parseCompanySettings(company.settingsJson, company.bank);
      return {
        id: company.id,
        name: company.name,
        sender: String(mergedSettings?.automation?.mailImportSender ?? "g.gagua@dwellup.io"),
      };
    }),
  });
};

const saveMailImportSettingsHandler = async (req, res) => {
  try {
    const receiverEmail = String(req.body?.receiverEmail ?? "").trim();
    const receiverPassword = String(req.body?.receiverPassword ?? "").trim();
    const companySenders = Array.isArray(req.body?.companySenders) ? req.body.companySenders : [];
    if (!receiverEmail || !isValidEmail(receiverEmail)) {
      return res.status(400).json({ message: "Valid receiver email is required" });
    }
    if (!receiverPassword) {
      return res.status(400).json({ message: "Receiver password is required" });
    }

    const db = await dbPromise;
    await ensureUserMailImportColumns(db);
    await db.run(
      `UPDATE users
       SET mailImportReceiverEmail = ?, mailImportReceiverPassword = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [receiverEmail, receiverPassword, req.authUser.id],
    );

    for (const row of companySenders) {
      const companyId = Number(row?.companyId);
      const sender = String(row?.sender ?? "").trim().toLowerCase();
      if (!companyId || !isValidEmail(sender)) {
        return res.status(400).json({ message: "Each sender must be a valid email" });
      }
      const company = await getCompanyForUser(db, companyId, req.authUser);
      if (!company) {
        return res.status(404).json({ message: "Company not found" });
      }
      const current = parseCompanySettings(company.settingsJson, company.bank);
      const next = mergeCompanySettingsPatch(current, {
        automation: {
          ...current.automation,
          mailImportSender: sender,
        },
      });
      await db.run(
        `UPDATE companies
         SET settingsJson = ?, updatedAt = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(next), companyId],
      );
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("[mail-import-settings] save failed", error);
    return res.status(500).json({
      message: "Failed to save mail settings",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

app.get("/api/auth/mail-import-settings", getMailImportSettingsHandler);
app.get("/api/auth/mail-import-setting", getMailImportSettingsHandler);
app.get("/api/mail-import-settings", getMailImportSettingsHandler);

app.patch("/api/auth/mail-import-settings", saveMailImportSettingsHandler);
app.patch("/api/auth/mail-import-setting", saveMailImportSettingsHandler);
app.patch("/api/mail-import-settings", saveMailImportSettingsHandler);

app.patch("/api/auth/profile", async (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  const phone = String(req.body?.phone ?? "").trim();
  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "Invalid email" });
  }

  const db = await dbPromise;
  const id = req.authUser.id;
  const taken = await db.get(
    `SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?`,
    [email, id],
  );
  if (taken) {
    return res.status(409).json({ message: "Email already in use" });
  }

  const phoneValue = phone.length > 0 ? phone : null;
  await db.run(
    `UPDATE users
     SET email = ?, phone = ?, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [email, phoneValue, id],
  );

  const updated = await db.get(
    `SELECT id, email, role, phone
     FROM users
     WHERE id = ?`,
    [id],
  );

  return res.json({
    email: updated.email,
    phone: updated.phone ?? null,
    role: updated.role,
  });
});

app.post("/api/auth/change-password", async (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: "Current and new password are required" });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ message: "New password must be at least 8 characters" });
  }

  const db = await dbPromise;
  const userId = req.authUser.id;
  const row = await db.get(`SELECT password FROM users WHERE id = ?`, [userId]);
  if (!row || row.password !== currentPassword) {
    return res.status(401).json({ message: "Current password is incorrect" });
  }

  await db.run(
    `UPDATE users
     SET password = ?, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [newPassword, userId],
  );

  return res.json({ ok: true });
});

const logSmsProdHints = () => {
  if (profile !== "prod") {
    return;
  }
  const hasDirectKey = Boolean(
    process.env.SMSTO_BEARER_TOKEN?.trim() || process.env.SMSTO_API_KEY?.trim(),
  );
  if (process.env.SMSTO_DEV_BYPASS === "1") {
    console.warn(
      "[sms] SMSTO_DEV_BYPASS=1 — ლაივზე რეალური SMS გამორთულია (კოდი 11111). პროდაქშენზე ამოიღე ეს ცვლადი.",
    );
  }
  if (!hasDirectKey) {
    console.warn(
      "[sms] SMSTO_BEARER_TOKEN / SMSTO_API_KEY ცარიელია — ავტო OTP SMS (sms/send) არ იგზავნება. დააკოპირე ლოკალური server/.env-ის SMSTO_* ჰოსტის გარემოში (Plesk → Node.js → Environment ან systemd Environment=).",
    );
  }
  const verifyIssue = getSmsSetupIssue();
  if (verifyIssue) {
    console.warn(`[sms] Verify API (SMS კოდი ხელით ნომერზე): ${verifyIssue.message}`);
  }
};

initializeDb()
  .then(() => {
    logSmsProdHints();
    startEmailStatementImportWatcher({
      dbPromise,
      uploadsDir,
      dataDir: path.join(__dirname, "data"),
    });
    app.listen(port, () => {
      console.log(`Bookwise API | profile=${profile} | http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database", error);
    if (error?.code === "ECONNREFUSED") {
      console.error(`
→ MySQL არ უსმინს. გაუშვი MySQL ან შეამოწმე host/port (config/local.js ან env).
`);
    }
    if (error?.errno === 1045 || error?.code === "ER_ACCESS_DENIED_ERROR") {
      console.error(`
→ MySQL access denied. პროფილი: ${profile}
  დააყენე სწორი DB_USER / DB_PASSWORD (გარემო ან server/.env) ან prod პროფილზე შეავსე server/config/prod.js
`);
    }
    process.exit(1);
  });

app.use((error, _req, res, _next) => {
  if (error?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      message: "Uploaded file is too large. Max allowed size is 20MB.",
    });
  }

  return res.status(500).json({
    message: "Unhandled server error",
    error: error instanceof Error ? error.message : "Unknown error",
  });
});
