import mysql from "mysql2/promise";
import { db as dbConfig } from "./config/index.js";

const ALLOWED_BANKS = ["TBC", "BOG", "LIBERTY", "TERABANK", "PROCREDIT", "CREDO"];

const createDbAdapter = async () => {
  const adminPool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
  });

  await adminPool.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await adminPool.end();

  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
  });

  return {
    exec: async (sql) => {
      await pool.query(sql);
    },
    run: async (sql, params = []) => {
      const [result] = await pool.execute(sql, params);
      return {
        lastID: result?.insertId ?? 0,
        changes: result?.affectedRows ?? 0,
      };
    },
    get: async (sql, params = []) => {
      const [rows] = await pool.execute(sql, params);
      return Array.isArray(rows) ? (rows[0] ?? undefined) : undefined;
    },
    all: async (sql, params = []) => {
      const [rows] = await pool.execute(sql, params);
      return Array.isArray(rows) ? rows : [];
    },
  };
};

const ensureColumnExists = async (db, tableName, columnName, columnDefinition) => {
  const row = await db.get(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName],
  );
  if (!row?.COLUMN_NAME) {
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
};

export const dbPromise = createDbAdapter();

export const initializeDb = async () => {
  const db = await dbPromise;
  const bankEnum = ALLOWED_BANKS.map((bank) => `'${bank}'`).join(", ");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
      sessionToken VARCHAR(255) NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      bank ENUM(${bankEnum}) NOT NULL,
      balancePassword VARCHAR(255) NOT NULL,
      ownerUserId INT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_companies_owner FOREIGN KEY (ownerUserId) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS company_excel_uploads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      companyId INT NOT NULL,
      reportDate VARCHAR(10) NOT NULL,
      fileName VARCHAR(255) NOT NULL,
      storedFileName VARCHAR(255) NULL,
      accountCode VARCHAR(50) NOT NULL DEFAULT '1210.01',
      runStatus VARCHAR(50) NULL,
      runMessage TEXT NULL,
      runAnalyticsJson LONGTEXT NULL,
      resultScreenshotFileName VARCHAR(255) NULL,
      lastRunAt DATETIME NULL,
      totalRows INT NOT NULL DEFAULT 0,
      inserted INT NOT NULL DEFAULT 0,
      updated INT NOT NULL DEFAULT 0,
      skipped INT NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_company_uploads_company FOREIGN KEY (companyId) REFERENCES companies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS balance_import_row_outcomes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      importId INT NOT NULL,
      rowIndex INT NOT NULL,
      rowKey VARCHAR(255) NULL,
      outcome VARCHAR(48) NOT NULL,
      message TEXT NULL,
      warning TEXT NULL,
      objectName VARCHAR(512) NULL,
      transactionType VARCHAR(64) NULL,
      amountText VARCHAR(64) NULL,
      detailJson LONGTEXT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_balance_row_outcomes_import FOREIGN KEY (importId) REFERENCES company_excel_uploads(id) ON DELETE CASCADE,
      KEY idx_balance_row_outcomes_import (importId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS balance_import_run_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      companyId INT NOT NULL,
      importId INT NULL,
      runStatus VARCHAR(32) NOT NULL,
      totalRows INT NOT NULL DEFAULT 0,
      autoBookedCount INT NOT NULL DEFAULT 0,
      needsReviewCount INT NOT NULL DEFAULT 0,
      failedCount INT NOT NULL DEFAULT 0,
      processingSeconds DECIMAL(14, 3) NOT NULL,
      errorsJson LONGTEXT NULL,
      rowOutcomeSummaryJson LONGTEXT NULL,
      KEY idx_balance_run_logs_company (companyId),
      KEY idx_balance_run_logs_created (createdAt),
      CONSTRAINT fk_balance_run_logs_company FOREIGN KEY (companyId) REFERENCES companies(id) ON DELETE CASCADE,
      CONSTRAINT fk_balance_run_logs_import FOREIGN KEY (importId) REFERENCES company_excel_uploads(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await ensureColumnExists(db, "users", "role", "ENUM('admin', 'user') NOT NULL DEFAULT 'user'");
  await ensureColumnExists(db, "users", "sessionToken", "VARCHAR(255) NULL");
  await ensureColumnExists(db, "users", "phone", "VARCHAR(32) NULL");
  await ensureColumnExists(db, "users", "mailImportReceiverEmail", "VARCHAR(255) NULL");
  await ensureColumnExists(db, "users", "mailImportReceiverPassword", "VARCHAR(255) NULL");
  await ensureColumnExists(db, "companies", "ownerUserId", "INT NULL");
  await ensureColumnExists(db, "companies", "phone", "VARCHAR(32) NULL");
  await ensureColumnExists(db, "companies", "inactive", "TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumnExists(db, "companies", "settingsJson", "LONGTEXT NULL");
  await ensureColumnExists(db, "company_excel_uploads", "storedFileName", "VARCHAR(255) NULL");
  await ensureColumnExists(db, "company_excel_uploads", "runStatus", "VARCHAR(50) NULL");
  await ensureColumnExists(db, "company_excel_uploads", "runMessage", "TEXT NULL");
  await ensureColumnExists(db, "company_excel_uploads", "runAnalyticsJson", "LONGTEXT NULL");
  await ensureColumnExists(db, "company_excel_uploads", "resultScreenshotFileName", "VARCHAR(255) NULL");
  await ensureColumnExists(db, "company_excel_uploads", "lastRunAt", "DATETIME NULL");
  await ensureColumnExists(
    db,
    "company_excel_uploads",
    "accountCode",
    "VARCHAR(50) NOT NULL DEFAULT '1210.01'",
  );
  await ensureColumnExists(db, "company_excel_uploads", "contentSha256", "CHAR(64) NULL");

  await db.run(
    `INSERT IGNORE INTO users (email, password, role)
     VALUES (?, ?, ?)`,
    ["info@book-wise.ge", "Yavela199@", "admin"],
  );
  await db.run(
    `INSERT IGNORE INTO users (email, password, role)
     VALUES (?, ?, ?)`,
    ["Davidyavelashvili@gmail.com", "Yavela199@", "user"],
  );
  await db.run(
    `INSERT IGNORE INTO users (email, password, role)
     VALUES (?, ?, ?)`,
    ["gegagagua@gmail.com", "Yavela199@", "admin"],
  );

  await db.run(
    `UPDATE users
     SET role = 'admin'
     WHERE LOWER(email) = LOWER(?)`,
    ["info@book-wise.ge"],
  );
  await db.run(
    `UPDATE users
     SET role = 'user', password = ?
     WHERE LOWER(email) = LOWER(?)`,
    ["Yavela199@", "Davidyavelashvili@gmail.com"],
  );
  await db.run(
    `UPDATE users
     SET role = 'admin', password = ?
     WHERE LOWER(email) = LOWER(?)`,
    ["Yavela199@", "gegagagua@gmail.com"],
  );

  await db.run(`UPDATE users SET phone = ? WHERE LOWER(email) = LOWER(?)`, [
    "+995597887736",
    "info@book-wise.ge",
  ]);

  await db.run(
    `INSERT INTO users (email, password, role, phone)
     VALUES (?, ?, 'user', ?)
     ON DUPLICATE KEY UPDATE password = VALUES(password), phone = VALUES(phone)`,
    ["kavelashvili.irakli@gmail.com", "Test123!@#", "+995579702072"],
  );

  const adminUser = await db.get(
    `SELECT id
     FROM users
     WHERE LOWER(email) = LOWER(?)`,
    ["info@book-wise.ge"],
  );
  if (adminUser?.id) {
    await db.run(
      `UPDATE companies
       SET ownerUserId = ?
       WHERE ownerUserId IS NULL`,
      [adminUser.id],
    );
  }
};
