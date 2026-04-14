const SEND_URL = "https://api.sms.to/sms/send";

export const sendDirectTransactionalSms = async (to, message) => {
  const key =
    process.env.SMSTO_BEARER_TOKEN?.trim() || process.env.SMSTO_API_KEY?.trim() || "";
  if (!key) {
    return { ok: false, status: 0, detail: "no_api_key" };
  }
  try {
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
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, detail: text.slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.message : "network" };
  }
};
