#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander";
import {
  demoCommand,
  evaluateCommand,
  generateCommand,
  graphCommand,
  previewCommand,
  resumeCommand,
  runCommand,
  type GraphKind,
  type RunOutcomeSummary,
} from "./cli/commands.js";
import { createLogger, type LogLevel } from "./observability/logger.js";

const logger = createLogger({ level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info" });

function number(label: string) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new InvalidArgumentError(`${label} must be a number, got "${value}"`);
    return parsed;
  };
}

function integer(label: string) {
  return (value: string): number => {
    const parsed = number(label)(value);
    if (!Number.isInteger(parsed)) throw new InvalidArgumentError(`${label} must be a whole number, got "${value}"`);
    return parsed;
  };
}

/** Fresh invoices on every run; `--seed <n>` pins it and the run prints the seed it used. */
const defaultSeed = Date.now() % 1_000_000;

const providerOption = () => new Option("--provider <name>", "LLM provider").choices(["fake", "anthropic"]);
const reviewOption = () =>
  new Option("--review <mode>", "how queued invoices are decided (default: interactive on a TTY, else approve)").choices([
    "interactive",
    "approve",
    "reject",
  ]);
/** `demo` is non-interactive by default, so it gets its own wording. */
const demoReviewOption = () =>
  new Option("--review <mode>", "how queued invoices are decided (default: approve)").choices([
    "interactive",
    "approve",
    "reject",
  ]);
const checkpointerOption = () =>
  new Option("--checkpointer <kind>", "where graph state is saved").choices(["memory", "sqlite"]);

/** A failed sink is a failed run, even though the batch itself finished. */
function applyExitCode(summary: RunOutcomeSummary): void {
  if (summary.failedDeliveries === 0) return;
  logger.error(`${summary.failedDeliveries} delivery target(s) failed for batch ${summary.batchId}`);
  process.exitCode = 1;
}

const program = new Command();

program
  .name("lang-chain-demo")
  .description("Invoice-processing pipeline built on LangChain.js and LangGraph.js")
  .version("0.1.0")
  .showHelpAfterError();

program
  .command("generate")
  .description("generate a seeded batch of invoice documents and show the raw + ground-truth tables")
  .option("-n, --count <n>", "how many invoices", integer("--count"), 10)
  .option("--seed <n>", "RNG seed (default: time-derived, printed on every run)", integer("--seed"), defaultSeed)
  .option("--defect-rate <r>", "share of invoices that get a defect (0..1)", number("--defect-rate"), 0.35)
  .option("--batch-id <id>", "override the generated batch id")
  .option("--out <dir>", "output directory (default: OUT_DIR or ./out)")
  .action(async (opts) => {
    await generateCommand(opts, logger);
  });

program
  .command("preview")
  .description("show the raw documents of an existing batch")
  .argument("<batchId>")
  .option("--show <docId>", "print the full text of one document")
  .option("--ground-truth", "also print the ground-truth table")
  .option("--out <dir>", "output directory")
  .action(async (batchId: string, opts) => {
    await previewCommand(batchId, opts, logger);
  });

program
  .command("run")
  .description("process a batch: extract, validate, categorise, investigate, review, summarise, deliver")
  .argument("<batchId>")
  .addOption(providerOption())
  .option("--model <id>", "Anthropic model id")
  .addOption(reviewOption())
  .option("--email <to>", "also deliver the report to this address")
  .option("--chaos <rate>", "fake-model failure rate (0..1) to exercise retries", number("--chaos"))
  .addOption(checkpointerOption())
  .option("--concurrency <n>", "max invoices processed in parallel", integer("--concurrency"))
  .option("--out <dir>", "output directory")
  .action(async (batchId: string, opts) => {
    applyExitCode(await runCommand(batchId, opts, logger));
  });

program
  .command("resume")
  .description("answer the review a previous run left pending and finish the batch (needs --checkpointer sqlite)")
  .argument("<threadId>")
  .addOption(
    new Option("--decision <action>", "approve or reject the pending invoice")
      .choices(["approve", "reject"])
      .makeOptionMandatory(),
  )
  .option("--note <text>", "note recorded with the decision")
  .addOption(reviewOption())
  .addOption(checkpointerOption())
  .addOption(providerOption())
  .option("--model <id>", "Anthropic model id")
  .option("--email <to>", "also deliver the report to this address")
  .option("--concurrency <n>", "max invoices processed in parallel", integer("--concurrency"))
  .option("--out <dir>", "output directory")
  .action(async (threadId: string, opts) => {
    applyExitCode(await resumeCommand(threadId, opts, logger));
  });

program
  .command("evaluate")
  .description("score a processed batch against the ground truth")
  .argument("<batchId>")
  .option("--out <dir>", "output directory")
  .action(async (batchId: string, opts) => {
    await evaluateCommand(batchId, opts, logger);
  });

program
  .command("graph")
  .description("print the compiled graphs as Mermaid")
  .addOption(new Option("--which <graph>", "which graph to draw").choices(["invoice", "batch", "both"]).default("both"))
  .action(async (opts: { which: GraphKind }) => {
    await graphCommand(opts, logger);
  });

program
  .command("demo")
  .description("generate, run and evaluate a batch in one go")
  .option("-n, --count <n>", "how many invoices", integer("--count"), 8)
  .option("--seed <n>", "RNG seed (default: time-derived, printed on every run)", integer("--seed"), defaultSeed)
  .option("--defect-rate <r>", "share of invoices that get a defect (0..1)", number("--defect-rate"), 0.35)
  .addOption(providerOption())
  .option("--model <id>", "Anthropic model id")
  .addOption(demoReviewOption())
  .option("--email <to>", "also deliver the report to this address")
  .option("--chaos <rate>", "fake-model failure rate (0..1)", number("--chaos"))
  .addOption(checkpointerOption())
  .option("--concurrency <n>", "max invoices processed in parallel", integer("--concurrency"))
  .option("--out <dir>", "output directory")
  .action(async (opts) => {
    applyExitCode(await demoCommand(opts, logger));
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  if (logger.level === "debug" && error instanceof Error && error.stack) logger.raw(error.stack);
  process.exitCode = 1;
}
