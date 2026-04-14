import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import mysql from "mysql2/promise";
import { db as dbConfig } from "./config/index.js";
import { initializeDb } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlitePath = path.join(__dirname, "data", "bookwise.sqlite");

const setAutoIncrement = async (connection, tableName, nextValue) => {
  const safeNext = Number.isFinite(nextValue) && nextValue > 0 ? Math.floor(nextValue) : 1;
  await connection.query(`ALTER TABLE ${tableName} AUTO_INCREMENT = ${safeNext}`);
};

const main = async () => {
  // Ensure MySQL schema/tables exist before importing data.
  await initializeDb();

  const sqliteDb = await open({
    filename: sqlitePath,
    driver: sqlite3.Database,
  });

  const mysqlConnection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    dateStrings: true,
  });

  try {
    const users = await sqliteDb.all(
      `SELECT id, email, password, role, sessionToken, createdAt, updatedAt
       FROM users
       ORDER BY id ASC`,
    );
    const companies = await sqliteDb.all(
      `SELECT id, email, name, bank, balancePassword, ownerUserId, createdAt, updatedAt
       FROM companies
       ORDER BY id ASC`,
    );
    const uploads = await sqliteDb.all(
      `SELECT id, companyId, reportDate, fileName, storedFileName, accountCode, runStatus, runMessage, runAnalyticsJson, resultScreenshotFileName, lastRunAt, totalRows, inserted, updated, skipped, createdAt
       FROM company_excel_uploads
       ORDER BY id ASC`,
    );

    await mysqlConnection.beginTransaction();
    await mysqlConnection.query("SET FOREIGN_KEY_CHECKS = 0");

    // Full sync: target DB mirrors source SQLite exactly.
    await mysqlConnection.query("DELETE FROM company_excel_uploads");
    await mysqlConnection.query("DELETE FROM companies");
    await mysqlConnection.query("DELETE FROM users");

    for (const user of users) {
      await mysqlConnection.execute(
        `INSERT INTO users (id, email, password, role, sessionToken, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          user.email,
          user.password,
          user.role || "user",
          user.sessionToken ?? null,
          user.createdAt ?? null,
          user.updatedAt ?? null,
        ],
      );
    }

    for (const company of companies) {
      await mysqlConnection.execute(
        `INSERT INTO companies (id, email, name, bank, balancePassword, ownerUserId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          company.id,
          company.email,
          company.name,
          company.bank,
          company.balancePassword,
          company.ownerUserId ?? null,
          company.createdAt ?? null,
          company.updatedAt ?? null,
        ],
      );
    }

    for (const upload of uploads) {
      await mysqlConnection.execute(
        `INSERT INTO company_excel_uploads (id, companyId, reportDate, fileName, storedFileName, accountCode, runStatus, runMessage, runAnalyticsJson, resultScreenshotFileName, lastRunAt, totalRows, inserted, updated, skipped, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          upload.id,
          upload.companyId,
          upload.reportDate,
          upload.fileName,
          upload.storedFileName ?? null,
          upload.accountCode ?? "1210.01",
          upload.runStatus ?? null,
          upload.runMessage ?? null,
          upload.runAnalyticsJson ?? null,
          upload.resultScreenshotFileName ?? null,
          upload.lastRunAt ?? null,
          Number(upload.totalRows ?? 0),
          Number(upload.inserted ?? 0),
          Number(upload.updated ?? 0),
          Number(upload.skipped ?? 0),
          upload.createdAt ?? null,
        ],
      );
    }

    const maxUserId = users.reduce((max, row) => Math.max(max, Number(row.id || 0)), 0);
    const maxCompanyId = companies.reduce((max, row) => Math.max(max, Number(row.id || 0)), 0);
    const maxUploadId = uploads.reduce((max, row) => Math.max(max, Number(row.id || 0)), 0);

    await setAutoIncrement(mysqlConnection, "users", maxUserId + 1);
    await setAutoIncrement(mysqlConnection, "companies", maxCompanyId + 1);
    await setAutoIncrement(mysqlConnection, "company_excel_uploads", maxUploadId + 1);

    await mysqlConnection.query("SET FOREIGN_KEY_CHECKS = 1");
    await mysqlConnection.commit();

    console.log(
      `Migration completed: users=${users.length}, companies=${companies.length}, uploads=${uploads.length}`,
    );
  } catch (error) {
    await mysqlConnection.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => undefined);
    await mysqlConnection.rollback().catch(() => undefined);
    throw error;
  } finally {
    await sqliteDb.close();
    await mysqlConnection.end();
  }
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("SQLite -> MySQL migration failed:", error);
    process.exit(1);
  });
