const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const MODEL = "claude-haiku-4-5-20251001";

// All OK-equivalent texts: Latin, Cyrillic, Georgian
const OK_TEXTS = ["OK", "Ok", "ok", "ОК", "Ок", "ок", "კარგი", "Да", "да", "Yes", "yes"];

// -------------------------------------------------------------------
// DOM-based dismiss: searches ALL frames, uses JS click + Enter key
// -------------------------------------------------------------------
const domDismissInFrame = async (frame) => {
  try {
    return await frame.evaluate((okTexts) => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      // Broad button selector covering 1C v8 web client patterns
      const btnSelectors = [
        "button",
        '[role="button"]',
        ".v8-button",
        '[class*="Btn"]',
        '[class*="btn"]',
        '[class*="button"]',
        ".gwt-Button",
        ".x-btn",
      ];

      // Modal/dialog container selectors (if present, prioritize buttons inside them)
      const modalSelectors = [
        ".v8-modal-window",
        ".v8-ui-modal-back",
        '[class*="modal"]',
        '[class*="dialog"]',
        '[class*="popup"]',
        '[class*="message"]',
        ".v8-form-back",
        ".gwt-DialogBox",
        '[role="dialog"]',
        '[role="alertdialog"]',
      ];

      const clickOkIn = (root) => {
        for (const sel of btnSelectors) {
          for (const btn of root.querySelectorAll(sel)) {
            const text = (btn.textContent || "").trim();
            if (okTexts.includes(text) && isVisible(btn)) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      };

      // 1. Try inside modal containers first
      for (const sel of modalSelectors) {
        for (const modal of document.querySelectorAll(sel)) {
          if (isVisible(modal) && clickOkIn(modal)) return true;
        }
      }

      // 2. Fallback: any visible OK button anywhere on page
      return clickOkIn(document);
    }, OK_TEXTS);
  } catch {
    return false;
  }
};

const domDismissAllFrames = async (page) => {
  // Also try pressing Enter — 1C message dialogs always respond to Enter
  const tryEnter = async () => {
    try { await page.keyboard.press("Enter"); } catch { /* ignore */ }
  };

  const frames = [page.mainFrame(), ...page.frames()];
  for (const frame of frames) {
    try {
      const clicked = await domDismissInFrame(frame);
      if (clicked) {
        await page.waitForTimeout(350);
        return true;
      }
    } catch { /* next frame */ }
  }

  // Last resort: Enter key (closes most 1C OK-only dialogs)
  await tryEnter();
  return false;
};

// -------------------------------------------------------------------
// AI vision check (optional — only if ANTHROPIC_API_KEY is set)
// -------------------------------------------------------------------
const callVision = async (base64Jpeg) => {
  if (!ANTHROPIC_API_KEY) return "SKIP";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16,
        system:
          "You analyze screenshots of a Georgian accounting web app (Balance.ge / 1C). " +
          "Detect if a blocking modal dialog is visible that needs user action (OK, Close, etc.).",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg } },
              {
                type: "text",
                text: 'Is there a blocking modal/popup dialog visible that needs to be dismissed (OK, კარგი, ОК, Close, etc.)? Reply ONLY: "YES" or "NO".',
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return "SKIP";
    const data = await res.json();
    return String(data?.content?.[0]?.text ?? "NO").trim().toUpperCase();
  } catch {
    return "SKIP";
  }
};

// -------------------------------------------------------------------
// Main export: called at every markStep
// -------------------------------------------------------------------
export const aiDismissDialogIfPresent = async (page) => {
  if (!page || page.isClosed()) return;
  try {
    if (ANTHROPIC_API_KEY) {
      // AI path: screenshot → vision check → dismiss if YES
      const buf = await page.screenshot({ fullPage: false, type: "jpeg", quality: 50 });
      const answer = await callVision(buf.toString("base64"));
      if (answer === "YES") {
        await domDismissAllFrames(page);
      }
    } else {
      // No API key: always run DOM check — fast, no network call
      await domDismissAllFrames(page);
    }
  } catch { /* must never block automation */ }
};
