import { randomUUID } from "node:crypto";

const ALLOWED_BANKS = ["TBC", "BOG", "LIBERTY", "TERABANK", "PROCREDIT", "CREDO"];

export const defaultCompanySettings = (companyBank) => {
  const bank = ALLOWED_BANKS.includes(companyBank) ? companyBank : "TBC";
  return {
    bankAccounts: [
      {
        id: randomUUID(),
        bank,
        accountName: "Main operating",
        currency: "GEL",
        inactive: false,
        lastStatementDate: null,
      },
    ],
    accounting: {
      systemName: "1C:Enterprise 8.3",
      connected: false,
      lastSyncAt: null,
      username: "",
      hasCredentials: false,
    },
    automation: {
      autoRunAfterUpload: true,
      allowAiSuggestRules: true,
      mailImportSender: "g.gagua@dwellup.io",
    },
  };
};

const deepMerge = (base, patch) => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return base;
  }
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const bv = base[k];
    if (pv && typeof pv === "object" && !Array.isArray(pv) && bv && typeof bv === "object" && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
};

export const parseCompanySettings = (settingsJson, companyBank) => {
  const defaults = defaultCompanySettings(companyBank);
  if (!settingsJson || typeof settingsJson !== "string") {
    return defaults;
  }
  try {
    const parsed = JSON.parse(settingsJson);
    if (!parsed || typeof parsed !== "object") {
      return defaults;
    }
    const merged = deepMerge(defaults, parsed);
    if (!Array.isArray(merged.bankAccounts) || merged.bankAccounts.length === 0) {
      merged.bankAccounts = defaults.bankAccounts;
    }
    return merged;
  } catch {
    return defaults;
  }
};

export const mergeCompanySettingsPatch = (current, patch) => {
  if (!patch || typeof patch !== "object") {
    return current;
  }
  const next = {
    bankAccounts: Array.isArray(current.bankAccounts) ? [...current.bankAccounts] : [],
    automation: { ...current.automation },
    accounting: { ...current.accounting },
  };
  if (patch.automation && typeof patch.automation === "object") {
    next.automation = { ...current.automation, ...patch.automation };
  }
  if (patch.accounting && typeof patch.accounting === "object") {
    next.accounting = { ...current.accounting, ...patch.accounting };
  }
  if (Array.isArray(patch.bankAccounts)) {
    next.bankAccounts = patch.bankAccounts.map((a) => ({
      inactive: false,
      lastStatementDate: null,
      ...a,
      id: typeof a?.id === "string" && a.id.length > 0 ? a.id : randomUUID(),
    }));
  }
  return next;
};
