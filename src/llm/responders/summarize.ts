import { PROMPT_MARKERS } from "../../domain/constants.js";
import { batchAmount, currencyLabelFrom } from "../../report/format.js";
import type { ScriptedResponse } from "./router.js";

/** Writes a 3-5 sentence operations digest from the batch stats block. */
export function respondSummarize(statsJson: string | null, humanText: string): ScriptedResponse {
  const { stats, error } = readStats(statsJson);
  if (error !== null) return { kind: "text", text: unreadableStatsText(error, humanText) };
  if (!stats) return { kind: "text", text: missingStatsText(humanText) };

  // The stats block carries no currency, so the amounts are labelled from the prompt's Currencies line.
  const money = moneyIn(readCurrencies(humanText));
  const num = (key: string): number => (typeof stats[key] === "number" ? (stats[key] as number) : 0);
  const rejected = num("rejectedByHuman") + num("autoRejected");

  const sentences = [
    `Processed ${num("total")} invoices worth ${money(num("totalAmount"))} in total.`,
    `${num("autoApproved")} were auto-approved and ${num("approvedByHuman")} were approved by a reviewer, releasing ${money(
      num("approvedAmount"),
    )} for payment.`,
    `${rejected} were rejected and ${num("needsReview")} are still waiting on review.`,
    topEntry(
      stats["issuesByCode"],
      (key, count) => `The most frequent issue was ${key} (${count} occurrence${count === 1 ? "" : "s"}).`,
    ) ?? "No validation issues were recorded.",
    topEntry(
      stats["byCategory"],
      (key, count) => `${key} was the largest spend category with ${count} invoice${count === 1 ? "" : "s"}.`,
    ) ?? "No categorised spend was recorded.",
  ];

  return { kind: "text", text: sentences.join(" ") };
}

/** Batch sums are currency-blind, so they are printed with the same label the reports use. */
function moneyIn(currencies: string[]): (value: number) => string {
  const label = currencyLabelFrom(currencies);
  let noted = false;
  return (value) => {
    // The mixed-currency caveat belongs on the first figure only; repeating it clutters the paragraph.
    const text = batchAmount(value, noted ? { ...label, note: "" } : label);
    noted = true;
    return text;
  };
}

/** Reads the prompt's `Currencies: USD, EUR` line; an absent or empty list means "unlabelled". */
function readCurrencies(humanText: string): string[] {
  const index = humanText.indexOf(PROMPT_MARKERS.currencies);
  if (index < 0) return [];
  const line = humanText.slice(index + PROMPT_MARKERS.currencies.length).split("\n")[0] ?? "";
  return line
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "none recorded");
}

/** Highest-count entry of a `Record<string, number>` rendered through `format`. */
function topEntry(value: unknown, format: (key: string, count: number) => string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  if (entries.length === 0) return null;
  const top = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return format(top[0], top[1]);
}

/** The stats block was there but unreadable — say so rather than reporting zeros. */
function unreadableStatsText(error: string, humanText: string): string {
  const highlights = collectHighlights(humanText);
  return [
    `The batch statistics could not be read (${error}), so no figures are reported below.`,
    "Counts, approved value and category totals for this run are all unavailable.",
    highlights.length > 0
      ? `The run did report ${highlights.length} highlight${highlights.length === 1 ? "" : "s"}, the first being: ${highlights[0]}`
      : "No highlights were reported either, so the run needs to be re-inspected before anything is paid.",
  ].join(" ");
}

/** No stats block at all — fall back to whatever highlights the prompt carried. */
function missingStatsText(humanText: string): string {
  const highlights = collectHighlights(humanText);
  if (highlights.length === 0) {
    return "No batch statistics were supplied. Nothing could be summarised for this run. Re-run the batch to produce a report.";
  }
  return [
    "No batch statistics were supplied, so this digest is based on the highlights only.",
    `${highlights.length} highlight${highlights.length === 1 ? " was" : "s were"} reported.`,
    `The first of them: ${highlights[0]}`,
  ].join(" ");
}

function collectHighlights(humanText: string): string[] {
  const index = humanText.indexOf("Highlights:");
  if (index < 0) return [];
  return humanText
    .slice(index + "Highlights:".length)
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => line !== "" && line !== "none")
    .map((line) => (line.endsWith(".") ? line : `${line}.`));
}

function readStats(statsJson: string | null): { stats: Record<string, unknown> | null; error: string | null } {
  if (!statsJson) return { stats: null, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(statsJson);
  } catch (err) {
    return { stats: null, error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { stats: null, error: "batch statistics were not a JSON object" };
  }
  return { stats: parsed as Record<string, unknown>, error: null };
}
