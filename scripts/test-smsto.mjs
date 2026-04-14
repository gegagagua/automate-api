import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SMSTO_BEARER_TOKEN } from "../config/smstoDefaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const AUTH_URL = "https://auth.sms.to/oauth/token";
const CREATE_URL = "https://verifyapi.sms.to/api/v1/verifications/create";

const bearer =
  process.env.SMSTO_BEARER_TOKEN?.trim() ||
  process.env.SMSTO_API_KEY?.trim() ||
  DEFAULT_SMSTO_BEARER_TOKEN;
const clientId = process.env.SMSTO_CLIENT_ID?.trim();
const secret = process.env.SMSTO_SECRET?.trim();
const appGuid = process.env.SMSTO_APP_GUID?.trim();
const testPhone = process.argv[2] || "+995597887737";

const basic = (a, b) => `Basic ${Buffer.from(`${a}:${b}`, "utf8").toString("base64")}`;

async function main() {
  console.log("SMSTO_BEARER_TOKEN / SMSTO_API_KEY:", Boolean(bearer));
  console.log("SMSTO_CLIENT_ID+SECRET:", Boolean(clientId && secret));
  console.log("SMSTO_APP_GUID:", Boolean(appGuid));

  let token = bearer;

  if (!token && clientId && secret) {
    const res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: clientId,
        secret,
        grant_type: "client_credentials",
      }),
    });
    const text = await res.text();
    console.log("\nOAuth form HTTP", res.status, text.slice(0, 400));
    let j = {};
    try {
      j = JSON.parse(text);
    } catch {
      j = {};
    }
    token = j.jwt ?? j.access_token ?? j.token ?? "";
  }

  if (!token) {
    console.error("\nNo bearer token. Set SMSTO_BEARER_TOKEN or SMSTO_API_KEY (dashboard API Key).");
    process.exit(1);
  }

  if (!appGuid) {
    console.error("\nSet SMSTO_APP_GUID (Verify app GUID in sms.to).");
    process.exit(1);
  }

  const reference = randomUUID();
  const digits = testPhone.replace(/\D/g, "");
  const recipient = `+${digits}`;

  const cr = await fetch(CREATE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      guid: appGuid,
      recipient,
      reference,
    }),
  });
  const ctext = await cr.text();
  console.log("\nverify/create HTTP", cr.status);
  console.log(ctext.slice(0, 1200));
  process.exit(cr.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
