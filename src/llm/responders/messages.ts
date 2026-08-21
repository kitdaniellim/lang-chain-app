import type { BaseMessage } from "@langchain/core/messages";

/** Message/marker helpers shared by the router and the responders (no imports back into either). */

/** Flattens string or content-block message content into plain text. */
export function messageText(message: BaseMessage | undefined): string {
  if (!message) return "";
  const content: unknown = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("\n");
  }
  return "";
}

/** Text between two markers, or null when either marker is missing. */
export function sectionBetween(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(close, start + open.length);
  if (end < 0) return null;
  return text.slice(start + open.length, end).trim();
}

/** Content of the most recent human message (the payload carrier in every prompt here). */
export function lastHumanText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.getType() === "human") return messageText(message);
  }
  return messageText(messages[messages.length - 1]);
}
