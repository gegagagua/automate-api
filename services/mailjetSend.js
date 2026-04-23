import Mailjet from "node-mailjet";

const DEFAULT_API_KEY = "1c09de0751a7a0f9097448c78b8bccd0";
const DEFAULT_SECRET_KEY = "d03de113239c7d7e9c34d0de768d991e";
const DEFAULT_FROM_EMAIL = "info@book-wise.ge";
const DEFAULT_FROM_NAME = "Bookwise";

const getClient = () =>
  new Mailjet({
    apiKey: process.env.MAILJET_API_KEY?.trim() || DEFAULT_API_KEY,
    apiSecret: process.env.MAILJET_SECRET_KEY?.trim() || DEFAULT_SECRET_KEY,
  });

export const sendMailjetEmail = async ({ to, subject, text, html }) => {
  const fromEmail = process.env.MAILJET_FROM_EMAIL?.trim() || DEFAULT_FROM_EMAIL;
  const fromName = process.env.MAILJET_FROM_NAME?.trim() || DEFAULT_FROM_NAME;

  try {
    const result = await getClient()
      .post("send", { version: "v3.1" })
      .request({
        Messages: [
          {
            From: { Email: fromEmail, Name: fromName },
            To: [{ Email: String(to).trim() }],
            Subject: subject,
            TextPart: text,
            ...(html ? { HTMLPart: html } : {}),
          },
        ],
      });

    const msgId = result.body?.Messages?.[0]?.To?.[0]?.MessageID;
    console.log("[mailjet] email sent", { msgId, to, from: fromEmail });
    return { ok: true, httpStatus: result.response.status, data: result.body };
  } catch (err) {
    const httpStatus = err.statusCode ?? 0;
    const data = err.response?.body ?? {};
    console.error("[mailjet] email failed", httpStatus, data, { to });
    return { ok: false, httpStatus, data };
  }
};
