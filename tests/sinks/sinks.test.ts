import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Transporter } from "nodemailer";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryLogger } from "../../src/observability/logger.js";
import { ConsoleSink } from "../../src/sinks/console.js";
import { EmailSink } from "../../src/sinks/email.js";
import { FileSink } from "../../src/sinks/file.js";
import { createSinks } from "../../src/sinks/index.js";
import type { SinkContext } from "../../src/sinks/types.js";
import { makeBatchResult, makeProcessed } from "../fixtures/processed.js";

// Keeps every test offline: Ethereal always "fails" and SMTP options collapse to an in-memory transport.
vi.mock("nodemailer", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  const real = (mod.default ?? mod) as typeof import("nodemailer");
  const createTransport = (options: unknown, defaults?: unknown) => {
    createTransportCalls.push(options);
    const isJson = Boolean((options as { jsonTransport?: boolean } | null)?.jsonTransport);
    return isJson
      ? (real.createTransport as (o: unknown, d?: unknown) => unknown)(options, defaults)
      : real.createTransport({ jsonTransport: true });
  };
  const createTestAccount = async () => {
    throw new Error("ethereal unavailable (offline test)");
  };
  const patched = { ...real, createTransport, createTestAccount };
  return { ...mod, default: patched, createTransport, createTestAccount, getTestMessageUrl: real.getTestMessageUrl };
});

const createTransportCalls: unknown[] = [];

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lcd-sinks-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  createTransportCalls.length = 0;
});

function ctxFor(batchDir: string): SinkContext & { logger: ReturnType<typeof createMemoryLogger> } {
  return { batchDir, logger: createMemoryLogger("debug") };
}

const result = makeBatchResult();

describe("ConsoleSink", () => {
  it("prints a table row per invoice plus stats and summary", async () => {
    const sink = new ConsoleSink();
    const ctx = ctxFor("unused");
    const rc = await sink.deliver(result, ctx);

    const out = ctx.logger.lines.join("\n");
    expect(rc).toMatchObject({ sink: "console", ok: true });
    for (const p of result.processed) expect(out).toContain(p.invoiceNumber!);
    expect(out).toContain("auto_approved");
    expect(out).toContain("TOTAL_MISMATCH");
    expect(out).toContain(result.summary);
    expect(out).toContain("Auto-approved");
  });

  it("truncates long cells", async () => {
    const long = makeProcessed({
      documentId: "doc-long",
      extracted: { ...makeProcessed().extracted!, vendorName: "A Very Long Vendor Name That Will Not Fit In A Cell" },
    });
    const ctx = ctxFor("unused");
    await new ConsoleSink().deliver(makeBatchResult({ processed: [long] }), ctx);
    const out = ctx.logger.lines.join("\n");
    expect(out).toContain("…");
    expect(out).not.toContain("That Will Not Fit In A Cell");
  });
});

describe("ConsoleSink — amounts and failures", () => {
  it("labels the stats amounts with the batch currency", async () => {
    const single = ctxFor("unused");
    await new ConsoleSink().deliver(makeBatchResult({ processed: [makeProcessed()] }), single);
    expect(single.logger.lines.join("\n")).toContain("Approved USD 216.00 of USD 1,765.50");

    const mixed = ctxFor("unused");
    await new ConsoleSink().deliver(result, mixed);
    expect(mixed.logger.lines.join("\n")).toContain("mixed currencies: USD, EUR — summed as printed");
  });

  it("returns ok:false instead of throwing when a row cannot be rendered", async () => {
    const ctx = ctxFor("unused");
    const broken = { ...result, processed: [{ ...result.processed[0]!, issues: null as never }] };
    const rc = await new ConsoleSink().deliver(broken, ctx);
    expect(rc).toMatchObject({ sink: "console", ok: false });
    expect(rc.detail.length).toBeGreaterThan(0);
    expect(ctx.logger.lines.join("\n")).toContain("ERROR");
  });
});

describe("FileSink", () => {
  it("writes the four artefacts and lists them in the receipt", async () => {
    const dir = await tempDir();
    const ctx = ctxFor(dir);
    const rc = await new FileSink().deliver(result, ctx);

    expect(rc).toMatchObject({ sink: "file", ok: true });
    for (const rel of ["processed/results.json", "processed/results.csv", "report.html", "report.md"]) {
      expect(rc.detail).toContain(rel);
      await expect(fs.stat(path.join(dir, rel))).resolves.toBeTruthy();
    }

    // results.json is the whole BatchResult, which is what readResult() parses back.
    const json = JSON.parse(await fs.readFile(path.join(dir, "processed/results.json"), "utf8"));
    expect(json.processed).toHaveLength(3);
    expect(json.processed[0].documentId).toBe("doc-001");
    expect(json.stats).toBeDefined();
    expect(json.summary).toBe(result.summary);
    expect(json.batchId).toBe(result.batchId);

    const csv = await fs.readFile(path.join(dir, "processed/results.csv"), "utf8");
    expect(csv.trimEnd().split(/\r?\n/)).toHaveLength(4);

    expect(await fs.readFile(path.join(dir, "report.html"), "utf8")).toContain("<title>");
    expect(await fs.readFile(path.join(dir, "report.md"), "utf8")).toContain("# Invoice batch");
  });

  it("returns ok:false when the results cannot be serialised", async () => {
    const dir = await tempDir();
    const ctx = ctxFor(dir);
    const unserialisable = {
      ...result,
      processed: [{ ...result.processed[0]!, timings: { extract: 1n as unknown as number } }],
    };
    const rc = await new FileSink().deliver(unserialisable, ctx);
    expect(rc.ok).toBe(false);
    expect(rc.detail).toContain("BigInt");
    expect(ctx.logger.lines.join("\n")).toContain("ERROR");
  });

  it("returns ok:false when a report renderer throws", async () => {
    const dir = await tempDir();
    const ctx = ctxFor(dir);
    const broken = { ...result, processed: [{ ...result.processed[0]!, issues: null as never }] };
    const rc = await new FileSink().deliver(broken, ctx);
    expect(rc.ok).toBe(false);
    expect(ctx.logger.lines.join("\n")).toContain("ERROR");
  });

  it("returns ok:false when the batch dir cannot be created", async () => {
    const dir = await tempDir();
    const blocker = path.join(dir, "blocked");
    await fs.writeFile(blocker, "not a directory");

    const ctx = ctxFor(blocker);
    const rc = await new FileSink().deliver(result, ctx);
    expect(rc.ok).toBe(false);
    expect(rc.detail.length).toBeGreaterThan(0);
    expect(ctx.logger.lines.join("\n")).toContain("ERROR");
  });
});

function spyTransport(behaviour: "ok" | "throw" = "ok") {
  const sendMail = vi.fn(async (options: Record<string, unknown>) => {
    if (behaviour === "throw") throw new Error("smtp refused connection");
    return { messageId: "<test-message@local>", envelope: { from: options.from, to: [options.to] } };
  });
  const transporter = { sendMail } as unknown as Transporter;
  return { sendMail, factory: async () => transporter };
}

describe("EmailSink", () => {
  it("sends the HTML report with both attachments through the injected transport", async () => {
    const dir = await tempDir();
    const { sendMail, factory } = spyTransport();
    const sink = new EmailSink({ to: "ap@corp.example", from: "bot@corp.example", transportFactory: factory });
    const rc = await sink.deliver(result, ctxFor(dir));

    expect(rc).toMatchObject({ sink: "email", ok: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const sent = sendMail.mock.calls[0]![0] as Record<string, any>;
    expect(sent.to).toBe("ap@corp.example");
    expect(sent.from).toBe("bot@corp.example");
    expect(sent.html).toContain("INV-2026-0417");
    expect(sent.text).toContain("# Invoice batch");
    expect(sent.attachments).toHaveLength(2);
    expect(sent.attachments.map((a: { filename: string }) => a.filename)).toEqual(["results.json", "results.csv"]);
    expect(Buffer.isBuffer(sent.attachments[0].content)).toBe(true);
  });

  it("summarises the decisions in the subject", async () => {
    const dir = await tempDir();
    const { sendMail, factory } = spyTransport();
    await new EmailSink({ to: "a@b.example", from: "c@d.example", transportFactory: factory }).deliver(result, ctxFor(dir));
    const sent = sendMail.mock.calls[0]![0] as Record<string, string>;
    expect(sent.subject).toBe(`Invoice batch ${result.batchId}: 1 approved, 2 rejected, 0 pending`);
  });

  it("returns ok:false instead of throwing when sendMail fails", async () => {
    const dir = await tempDir();
    const { factory } = spyTransport("throw");
    const rc = await new EmailSink({ to: "a@b.example", from: "c@d.example", transportFactory: factory }).deliver(
      result,
      ctxFor(dir),
    );
    expect(rc.ok).toBe(false);
    expect(rc.detail).toContain("smtp refused connection");
  });

  it("uses the configured SMTP host", async () => {
    const dir = await tempDir();
    const sink = new EmailSink({
      to: "a@b.example",
      from: "c@d.example",
      smtp: { host: "smtp.corp.example", port: 2525, user: "u", pass: "p", secure: false },
    });
    const rc = await sink.deliver(result, ctxFor(dir));
    expect(createTransportCalls[0]).toMatchObject({
      host: "smtp.corp.example",
      port: 2525,
      secure: false,
      auth: { user: "u", pass: "p" },
    });
    expect(rc.ok).toBe(true);
    expect(rc.detail).toContain("sent via SMTP smtp.corp.example");
  });

  it("falls back to a JSON file when Ethereal is unreachable", async () => {
    const dir = await tempDir();
    const ctx = ctxFor(dir);
    const rc = await new EmailSink({ to: "a@b.example", from: "c@d.example" }).deliver(result, ctx);

    expect(rc.ok).toBe(true);
    expect(rc.detail).toContain("offline: message written to");
    const written = JSON.parse(await fs.readFile(path.join(dir, "email.json"), "utf8"));
    expect(written.subject).toContain(result.batchId);
    expect(written.attachments).toHaveLength(2);
    expect(written.attachments.map((a: { filename: string }) => a.filename)).toEqual([
      "results.json",
      "results.csv",
    ]);
    const csv = Buffer.from(written.attachments[1].content, "base64").toString("utf8");
    expect(csv).toContain("documentId,invoiceNumber,vendorName");
    expect(ctx.logger.lines.join("\n")).toContain("WARN");
  });
});

describe("createSinks", () => {
  it("returns console + file by default", () => {
    expect(createSinks({}).map((s) => s.name)).toEqual(["console", "file"]);
    expect(createSinks({ email: null }).map((s) => s.name)).toEqual(["console", "file"]);
  });

  it("appends the email sink when configured", () => {
    const sinks = createSinks({ email: { to: "a@b.example", from: "c@d.example" } });
    expect(sinks.map((s) => s.name)).toEqual(["console", "file", "email"]);
  });
});
