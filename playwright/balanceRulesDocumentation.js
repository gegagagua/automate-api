import { MSG } from "./balanceRowRules.js";

export const getBalanceRulesDocumentation = () => ({
  implementationFiles: [
    "server/playwright/balanceRowRules.js — deterministic evaluation (MCC, object name, outgoing, analytics match)",
    "server/playwright/balanceGridAutomation.js — Playwright UI (MCC filter, fills, document creation, logout)",
    "server/playwright/balanceGridExtract.js — grid cell extraction",
  ],
  errorMessages: { ...MSG },
  workflow: [
    {
      step: 1,
      title: "Row validation",
      detail:
        "Required fields from კორ ანგარიში onward; corr filled but analytics empty → failed_rule (invalid combination).",
    },
    {
      step: 2,
      title: "Missing data + MCC",
      detail:
        "If კორ ანგარიში empty and დანიშნულება has no MCC → skip with documented error. If no MCC in purpose → skip.",
    },
    {
      step: 3,
      title: "Object name",
      detail: 'Extract text between "ობიექტი:" and ";" in დანიშნულება. Failure → skip.',
    },
    {
      step: 4,
      title: "Transaction type",
      detail: "Only თანხის გასვლა with amount > 0 proceeds to full UI automation; otherwise skip.",
    },
    {
      step: 5,
      title: "Playwright: MCC on დანიშნულება",
      detail: "Per row: open Search, filter MCC (step 5 in automation). Global MCC filter attempted first.",
    },
    {
      step: 6,
      title: "Playwright: ჩატვირთვის წესი + კორ ანგარიში",
      detail: "Double-click cells: მომწოდებლისთვის თანხის გადახდა, 3110.01 when in full automation mode.",
    },
    {
      step: 7,
      title: "Playwright: ანალიტიკა",
      detail:
        "Type Object_Name; pick from bound list. No match → ESC + error. Multiple matches → first + warning.",
    },
    {
      step: 8,
      title: "Final validation",
      detail: "Re-runs evaluateBalanceRow on fresh grid; must be ready_for_document.",
    },
    {
      step: 9,
      title: "Document + logout",
      detail: "Checkbox, დოკუმენტის შექმნა, then session logout (unless skipLogout).",
    },
  ],
  email: {
    note: "Each run: Resend email to the Bookwise user who started the run (session users.email); from Bookwise <info@book-wise.ge> when domain is verified.",
  },
});
