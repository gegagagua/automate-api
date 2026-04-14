import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import local from "./local.js";
import prod from "./prod.js";
import { DEFAULT_SMSTO_BEARER_TOKEN } from "./smstoDefaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEnvPath = path.join(__dirname, "..", ".env");
const cwdEnvPath = path.join(process.cwd(), ".env");
for (const envPath of [serverEnvPath, cwdEnvPath]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

if (!process.env.SMSTO_BEARER_TOKEN?.trim() && !process.env.SMSTO_API_KEY?.trim()) {
  process.env.SMSTO_BEARER_TOKEN = DEFAULT_SMSTO_BEARER_TOKEN;
}

function resolveProfile() {
  const app = process.env.APP_ENV?.toLowerCase();
  if (app === "prod" || app === "production") return "prod";
  if (app === "local" || app === "development") return "local";
  if (process.env.NODE_ENV === "production") return "prod";
  return "local";
}

export const profile = resolveProfile();
export const db = profile === "prod" ? prod : local;

if (profile === "prod" && !db.password) {
  console.warn(
    "[config] პროფილი: prod — DB პაროლი ცარიელია. დააყენე DB_PASSWORD გარემოში ან შეავსე server/config/prod.js → defaults.password",
  );
}
