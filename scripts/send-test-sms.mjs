import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SMSTO_BEARER_TOKEN } from "../config/smstoDefaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const SEND_URL = "https://api.sms.to/sms/send";

const key =
  process.env.SMSTO_BEARER_TOKEN?.trim() ||
  process.env.SMSTO_API_KEY?.trim() ||
  DEFAULT_SMSTO_BEARER_TOKEN;
const to = process.argv[2]?.trim() || "+995597887736";
const message = process.argv[3]?.trim() || "Bookwise — სატესტო SMS";

async function main() {
  if (!key) {
    console.error("Missing SMSTO bearer (config/smstoDefaults.js or .env)");
    process.exit(1);
  }
  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      message,
      to,
      bypass_optout: true,
    }),
  });
  const text = await res.text();
  console.log("HTTP", res.status);
  console.log(text);
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
