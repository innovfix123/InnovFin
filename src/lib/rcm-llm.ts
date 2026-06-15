/**
 * AI bank-narration categoriser (OpenRouter → Claude). Given raw bank-statement expense
 * narrations the deterministic classifier couldn't place, it SUGGESTS a vendor + RCM bucket.
 *
 * Strictly advisory: suggestions feed the review queue for a human to confirm — they never
 * land directly in a tax figure. Fails soft: returns [] on no key / API error, so the
 * validated deterministic RCM path keeps working regardless.
 */

export interface ExpenseToCategorize {
  narration: string;
  amount: number;
}

export interface AiCategorization {
  narration: string;
  amount: number;
  vendor: string;
  category: "foreign" | "rent" | "other";
  reason: string;
}

const SYSTEM_PROMPT = `You categorise Indian company bank-statement expense narrations for GST Reverse Charge (RCM).
Buckets:
- "foreign" = import of services from a foreign vendor (e.g. Agora, Anthropic/Claude, OpenAI/ChatGPT, Cursor, Digital Ocean, Hostinger, Google Play, Slack, Canva, ElevenLabs, AWS, Higgsfield) → RCM IGST.
- "rent" = rent paid to an UNREGISTERED landlord (an individual, narration mentions RENT + a person's name) → RCM CGST+SGST. Office rent billed by a registered company is NOT rent-RCM.
- "other" = everything else: salaries, ads via Indian entities (Google Ads, Meta, Zocket), bank charges/markups (DC INTL POS TXN, MARKUP, DCC), reimbursements, creator payouts, GST/TDS, food, transfers.
Be conservative: if unsure, use "other". Return ONLY a JSON object: {"items":[{"index":<int>,"vendor":"<short name>","category":"foreign|rent|other","reason":"<short>"}]}.`;

/** Strip markdown fences / prose and parse the items array out of the model's reply. */
function extractItems(content: string): Array<{ index?: number; vendor?: string; category?: string; reason?: string }> {
  const cleaned = content.replace(/```(?:json)?/gi, "").trim();
  try {
    const p = JSON.parse(cleaned);
    if (Array.isArray(p)) return p;
    if (Array.isArray(p?.items)) return p.items;
    const firstArray = Object.values(p).find((v) => Array.isArray(v));
    if (Array.isArray(firstArray)) return firstArray;
  } catch {
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  }
  return [];
}

export async function categorizeExpensesLLM(expenses: ExpenseToCategorize[]): Promise<AiCategorization[]> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || expenses.length === 0) return [];
  const base = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  const model = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";

  const user = JSON.stringify(expenses.map((e, i) => ({ index: i, narration: e.narration, amount: e.amount })));

  let content = "";
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return []; // fail soft — deterministic path still works
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    content = data.choices?.[0]?.message?.content ?? "";
  } catch {
    return [];
  }

  const items = extractItems(content);
  const out: AiCategorization[] = [];
  for (const it of items) {
    const e = typeof it.index === "number" ? expenses[it.index] : undefined;
    if (!e) continue;
    const category = it.category === "foreign" || it.category === "rent" ? it.category : "other";
    out.push({ narration: e.narration, amount: e.amount, vendor: String(it.vendor ?? "").trim() || e.narration, category, reason: String(it.reason ?? "").trim() });
  }
  return out;
}
