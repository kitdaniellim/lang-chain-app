import fs from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";
import type { SentMessageInfo, Transporter } from "nodemailer";
import type { BatchResult, DeliveryReceipt } from "../domain/schemas.js";
import { toCsv } from "../report/csv.js";
import { renderHtmlReport } from "../report/html.js";
import { renderMarkdownReport } from "../report/markdown.js";
import type { Sink, SinkContext } from "./types.js";
import { receipt } from "./types.js";

export interface EmailSmtpOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  secure: boolean;
}

export interface EmailSinkOptions {
  to: string;
  from: string;
  smtp?: EmailSmtpOptions;
  /** Test seam: when present it wins over SMTP and Ethereal. */
  transportFactory?: () => Promise<Transporter>;
}

type TransportKind = "injected" | "smtp" | "ethereal" | "offline";

interface ResolvedTransport {
  transporter: Transporter;
  kind: TransportKind;
  host?: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Emails the HTML report with the JSON/CSV results attached.
 * Falls back through SMTP → Ethereal → an offline JSON file, and never throws.
 */
export class EmailSink implements Sink {
  readonly name = "email";

  constructor(private readonly opts: EmailSinkOptions) {}

  async deliver(result: BatchResult, ctx: SinkContext): Promise<DeliveryReceipt> {
    const s = result.stats;
    const approved = s.autoApproved + s.approvedByHuman;
    const rejected = s.autoRejected + s.rejectedByHuman;
    const message = {
      to: this.opts.to,
      from: this.opts.from,
      subject: `Invoice batch ${result.batchId}: ${approved} approved, ${rejected} rejected, ${s.needsReview} pending`,
      html: renderHtmlReport(result),
      text: renderMarkdownReport(result),
      attachments: [
        { filename: "results.json", content: Buffer.from(JSON.stringify(result, null, 2), "utf8") },
        { filename: "results.csv", content: Buffer.from(toCsv(result.processed), "utf8") },
      ],
    };

    let resolved: ResolvedTransport;
    try {
      resolved = await this.resolveTransport(ctx);
    } catch (error) {
      const detail = `could not create a mail transport: ${describe(error)}`;
      ctx.logger.error(`email sink failed: ${detail}`);
      return receipt(this.name, false, detail);
    }

    try {
      const info = await resolved.transporter.sendMail(message);
      const detail = await this.describeDelivery(resolved, info, ctx);
      ctx.logger.info(`email sink: ${detail}`);
      return receipt(this.name, true, detail);
    } catch (error) {
      const detail = describe(error);
      ctx.logger.error(`email sink failed: ${detail}`);
      return receipt(this.name, false, detail);
    }
  }

  /** transportFactory → SMTP → Ethereal → offline JSON transport. */
  private async resolveTransport(ctx: SinkContext): Promise<ResolvedTransport> {
    if (this.opts.transportFactory) {
      ctx.logger.info("email sink: using the injected transport");
      return { transporter: await this.opts.transportFactory(), kind: "injected" };
    }

    const smtp = this.opts.smtp;
    if (smtp?.host) {
      ctx.logger.info(`email sink: using SMTP ${smtp.host}:${smtp.port}`);
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      });
      return { transporter, kind: "smtp", host: smtp.host };
    }

    try {
      const account = await nodemailer.createTestAccount();
      ctx.logger.info(`email sink: using the Ethereal test account ${account.user}`);
      const transporter = nodemailer.createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        auth: { user: account.user, pass: account.pass },
      });
      return { transporter, kind: "ethereal" };
    } catch (error) {
      ctx.logger.warn(`email sink: Ethereal unavailable (${describe(error)}) — writing the message to disk instead`);
      return { transporter: nodemailer.createTransport({ jsonTransport: true }), kind: "offline" };
    }
  }

  /** Offline deliveries are persisted so the demo still has something to show. */
  private async describeDelivery(
    resolved: ResolvedTransport,
    info: SentMessageInfo,
    ctx: SinkContext,
  ): Promise<string> {
    if (resolved.kind === "offline") {
      const file = path.join(ctx.batchDir, "email.json");
      const body = typeof info?.message === "string" ? info.message : null;
      await fs.mkdir(ctx.batchDir, { recursive: true });
      if (body === null) {
        // The transport accepted the mail but handed back no serialised body; say so rather than writing "{}".
        ctx.logger.warn("email sink: the offline transport returned no message body");
        await fs.writeFile(file, JSON.stringify({ error: "transport returned no message body" }, null, 2), "utf8");
        return `offline: message written to ${file} (transport returned no message body)`;
      }
      await fs.writeFile(file, body, "utf8");
      return `offline: message written to ${file}`;
    }
    if (resolved.kind === "ethereal") {
      const preview = nodemailer.getTestMessageUrl(info);
      return preview
        ? `sent via Ethereal — preview: ${preview}`
        : `sent via Ethereal — messageId ${info?.messageId}`;
    }
    if (resolved.kind === "smtp") {
      return `sent via SMTP ${resolved.host} — messageId ${info.messageId}`;
    }
    return `sent via injected transport — messageId ${info.messageId}`;
  }
}
