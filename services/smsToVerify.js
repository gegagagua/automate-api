import { randomUUID } from "node:crypto";

// სპეკი: App/Services/SmsToVerifyService.php (Laravel Http — OAuth body JSON, იგივე URL-ები)
const AUTH_URL = "https://auth.sms.to/oauth/token";
const CREATE_URL = "https://verifyapi.sms.to/api/v1/verifications/create";
const CONFIRM_URL = "https://verifyapi.sms.to/api/v1/verifications/confirm";

const TOKEN_CACHE_MS = 3000 * 1000;

let cachedBearer = null;
let cachedBearerAt = 0;
let lastOAuthErrorBody = "";

const getEnv = () => ({
  bearerOverride:
    process.env.SMSTO_BEARER_TOKEN?.trim() ||
    process.env.SMSTO_API_KEY?.trim() ||
    "",
  clientId: process.env.SMSTO_CLIENT_ID?.trim() || "",
  secret: process.env.SMSTO_SECRET?.trim() || "",
  appGuid: process.env.SMSTO_APP_GUID?.trim() || "",
});

export const getSmsSetupIssue = () => {
  const { bearerOverride, clientId, secret, appGuid } = getEnv();
  if (!bearerOverride && !(clientId && secret)) {
    return {
      message:
        "SMS: set SMSTO_BEARER_TOKEN (API Key from dashboard) or SMSTO_CLIENT_ID + SMSTO_SECRET in server/.env",
    };
  }
  if (!appGuid) {
    return {
      message:
        "SMS: SMSTO_APP_GUID is empty. sms.to → Verify API → activate app (balance required) → copy Application GUID into server/.env. OTPs are not listed under Reports → Messages Log — use Verify → Verifications.",
    };
  }
  return null;
};

export const isSmsConfigured = () => getSmsSetupIssue() === null;

const parseTokenFromPayload = (data) => {
  if (!data || typeof data !== "object") {
    return null;
  }
  const token =
    data.jwt ??
    data.access_token ??
    data.token ??
    data.data?.jwt ??
    data.data?.access_token ??
    data.data?.token ??
    null;
  return typeof token === "string" && token ? token : null;
};

const basicAuthHeader = (clientId, secret) =>
  `Basic ${Buffer.from(`${clientId}:${secret}`, "utf8").toString("base64")}`;

const fetchOAuthToken = async (clientId, secret) => {
  const attempts = [
    {
      label: "basic+form+body",
      headers: {
        Authorization: basicAuthHeader(clientId, secret),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: clientId,
        secret,
        grant_type: "client_credentials",
      }),
    },
    {
      label: "form client_id+secret",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: clientId,
        secret,
        grant_type: "client_credentials",
      }),
    },
    {
      label: "form client_id+client_secret",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: secret,
        grant_type: "client_credentials",
      }),
    },
    {
      label: "json",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        secret,
        grant_type: "client_credentials",
      }),
    },
  ];
  let lastBody = "";
  for (const { headers, body } of attempts) {
    const response = await fetch(AUTH_URL, {
      method: "POST",
      headers,
      body,
    });
    const text = await response.text();
    lastBody = text.slice(0, 500);
    if (!response.ok) {
      continue;
    }
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
    const token = parseTokenFromPayload(data);
    if (token) {
      return { token, lastBody: "" };
    }
  }
  return { token: null, lastBody };
};

const getBearerToken = async () => {
  const { bearerOverride, clientId, secret } = getEnv();
  if (bearerOverride) {
    return bearerOverride;
  }
  if (!clientId || !secret) {
    return null;
  }
  const now = Date.now();
  if (cachedBearer && now - cachedBearerAt < TOKEN_CACHE_MS) {
    return cachedBearer;
  }
  const { token, lastBody } = await fetchOAuthToken(clientId, secret);
  if (!token) {
    cachedBearer = null;
    lastOAuthErrorBody = lastBody;
    return null;
  }
  lastOAuthErrorBody = "";
  cachedBearer = token;
  cachedBearerAt = now;
  return token;
};

export const digitsOnlyPhone = (raw) =>
  String(raw ?? "")
    .replace(/\0/g, "")
    .replace(/\D/g, "");

export const normalizePhone = (raw) => {
  const cleaned = digitsOnlyPhone(raw);
  if (!cleaned) return "";
  return `+${cleaned}`;
};

const isBlockedRecipient = (digits) => {
  const blocked =
    process.env.SMSTO_BLOCKED_NUMBERS?.split(/[,;\s]+/).map((s) => s.replace(/\D/g, "")).filter(Boolean) ?? [];
  return blocked.includes(digits);
};

export const sendOtp = async (phone) => {
  const { appGuid } = getEnv();
  if (!appGuid) {
    return { success: false, response: "SMSTO_APP_GUID is not set", httpCode: 0, verificationId: null };
  }
  const digits = digitsOnlyPhone(phone);
  if (isBlockedRecipient(digits)) {
    return {
      success: true,
      response: "SMS skipped for blocked number",
      httpCode: 200,
      verificationId: null,
      gateway: "blocked",
      blocked: true,
    };
  }
  const token = await getBearerToken();
  if (!token) {
    const hint = lastOAuthErrorBody ? ` OAuth: ${lastOAuthErrorBody}` : "";
    return {
      success: false,
      response: `Failed to obtain sms.to OAuth token.${hint}`,
      httpCode: 0,
      verificationId: null,
    };
  }
  const recipient = digits ? `+${digits}` : "";
  if (recipient.length < 8) {
    return { success: false, response: "Invalid phone number", httpCode: 0, verificationId: null };
  }
  const reference = randomUUID();
  let response;
  try {
    response = await fetch(CREATE_URL, {
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
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { success: false, response: e instanceof Error ? e.message : "Network error", httpCode: 0, verificationId: null };
  }
  const text = await response.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  const rawId =
    json?.data?.trackingId ??
    json?.data?.verification_id ??
    json?.data?.id ??
    json?.trackingId ??
    json?.verification_id ??
    (typeof json?.data === "string" ? json.data : null);
  const verificationId = rawId != null && rawId !== "" ? String(rawId) : null;
  const okHttp = response.ok || response.status === 201;
  const hasId = Boolean(verificationId?.length);
  const apiSaysOk = json?.success !== false;
  const appNotFound =
    response.status === 404 ||
    String(json?.message ?? "")
      .toLowerCase()
      .includes("application not found");
  let responseNote = text;
  if (appNotFound) {
    responseNote = `${text} | Fix: sms.to dashboard → Verify / 2FA (Number verification) → create or open your app → copy Application GUID → SMSTO_APP_GUID in server/.env (must match the same account as your API Key).`;
  }
  return {
    success: okHttp && hasId && apiSaysOk,
    response: responseNote,
    httpCode: response.status,
    verificationId: hasId ? verificationId : null,
    gateway: "smsto",
  };
};

export const verifyCode = async (verificationId, code) => {
  const token = await getBearerToken();
  if (!token) {
    return { success: false, response: "Failed to obtain sms.to token", httpCode: 0 };
  }
  let response;
  try {
    response = await fetch(CONFIRM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        verification_id: verificationId,
        password: String(code ?? ""),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { success: false, response: e instanceof Error ? e.message : "Network error", httpCode: 0 };
  }
  const text = await response.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  const isVerified = json?.success === true;
  return {
    success: isVerified,
    response: text,
    httpCode: response.status,
  };
};
