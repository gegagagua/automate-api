import { sendResendTestEmail } from "../services/resendBalanceNotify.js";

const result = await sendResendTestEmail("test");
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
