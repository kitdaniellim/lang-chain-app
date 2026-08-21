import { TOOL_NAMES } from "../../domain/constants.js";
import { CategorySchema, GL_ACCOUNTS, type Category } from "../../domain/schemas.js";
import type { ScriptedResponse } from "./router.js";

/** Keyword rules, evaluated in order; the first hit wins. */
const KEYWORD_RULES: ReadonlyArray<{ pattern: RegExp; category: Category }> = [
  { pattern: /hours|compute|storage|hosting/i, category: "CLOUD_HOSTING" },
  { pattern: /license|subscription|seat|software/i, category: "SOFTWARE" },
  { pattern: /paper|toner|pens|stapler/i, category: "OFFICE_SUPPLIES" },
  { pattern: /consulting|advisory|legal|retainer/i, category: "PROFESSIONAL_SERVICES" },
  { pattern: /flight|hotel|taxi|travel|per diem/i, category: "TRAVEL" },
  { pattern: /campaign|ads|design|branding/i, category: "MARKETING" },
  { pattern: /electricity|water|gas|utility/i, category: "UTILITIES" },
  { pattern: /laptop|monitor|server|printer|hardware/i, category: "EQUIPMENT" },
];

const HINT_CONFIDENCE = 0.9;
const KEYWORD_CONFIDENCE = 0.7;
/** The payload could not be read, so whatever we matched on is unreliable. */
const UNPARSABLE_CONFIDENCE = 0.3;

interface CategorizePayload {
  vendorName: string | null;
  descriptions: string[];
  /** Set when the extracted-invoice block was present but unreadable. */
  parseError: string | null;
}

/** Categorises from the vendor registry hint when present, else from line-item keywords. */
export function respondCategorize(payloadJson: string | null, hint: string | null): ScriptedResponse {
  const payload = readPayload(payloadJson);
  const hinted = hint ? CategorySchema.safeParse(hint.trim()) : null;

  const category = hinted?.success ? hinted.data : matchKeywords(payload.descriptions);
  const confidence = payload.parseError !== null ? UNPARSABLE_CONFIDENCE : hinted?.success ? HINT_CONFIDENCE : KEYWORD_CONFIDENCE;

  const rationale =
    payload.parseError !== null
      ? `The extracted-invoice payload could not be parsed (${payload.parseError}), so ${category} is a low-confidence guess from the raw text.`
      : hinted?.success
        ? `The vendor registry maps ${payload.vendorName ?? "this vendor"} to ${category}.`
        : `Line-item wording (${payload.descriptions.slice(0, 3).join("; ") || "no descriptions"}) best matches ${category}.`;

  return {
    kind: "tool_calls",
    toolCalls: [
      {
        name: TOOL_NAMES.categorize,
        args: { category, glAccount: GL_ACCOUNTS[category], confidence, rationale },
      },
    ],
  };
}

function matchKeywords(descriptions: string[]): Category {
  const haystack = descriptions.join(" ");
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(haystack)) return rule.category;
  }
  return "OTHER";
}

/** Accepts `lineItems` as plain strings or as objects with a `description`. */
function readPayload(payloadJson: string | null): CategorizePayload {
  if (!payloadJson) return { vendorName: null, descriptions: [], parseError: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (err) {
    // Still match keywords on the raw text, but say so and drop the confidence.
    const reason = err instanceof Error ? err.message : String(err);
    return { vendorName: null, descriptions: [payloadJson], parseError: reason };
  }

  const record = asRecord(parsed);
  if (!record) {
    return { vendorName: null, descriptions: [payloadJson], parseError: "payload was not a JSON object" };
  }

  const items = Array.isArray(record["lineItems"]) ? record["lineItems"] : [];
  const descriptions = items
    .map((item) => {
      if (typeof item === "string") return item;
      const description = asRecord(item)?.["description"];
      return typeof description === "string" ? description : "";
    })
    .filter((description) => description !== "");

  const vendorName = record["vendorName"];
  return {
    vendorName: typeof vendorName === "string" ? vendorName : null,
    descriptions,
    parseError: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
