import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

export const ConfigSchema = z.object({
  llmProvider: z.enum(["fake", "anthropic"]).default("fake"),
  anthropicModel: z.string().default("claude-opus-5"),
  anthropicApiKey: z.string().optional(),
  fakeFailureRate: z.coerce.number().min(0).max(1).default(0),
  fakeLatencyMs: z.coerce.number().min(0).default(0),
  llmMaxRetries: z.coerce.number().int().min(1).max(10).default(3),
  concurrency: z.coerce.number().int().min(1).max(32).default(4),
  outDir: z.string().default("out"),
  checkpointer: z.enum(["memory", "sqlite"]).default("memory"),
  email: z.object({
    to: z.string().optional(),
    from: z.string().default("ap-bot@lang-chain-demo.local"),
    smtpHost: z.string().optional(),
    smtpPort: z.coerce.number().int().default(587),
    smtpUser: z.string().optional(),
    smtpPass: z.string().optional(),
    smtpSecure: bool.default(false),
  }),
});
export type AppConfig = z.infer<typeof ConfigSchema>;
export type ConfigOverrides = Partial<Omit<AppConfig, "email">> & { email?: Partial<AppConfig["email"]> };

const blank = (v: string | undefined): string | undefined => (v && v.trim() !== "" ? v : undefined);

export interface LoadConfigOptions {
  /**
   * Reject `LLM_PROVIDER=anthropic` without an API key (default true). Commands that
   * never call a model (`generate`, `preview`, `evaluate`) pass false so a key-less
   * `.env` cannot stop them from running.
   */
  requireModelCredentials?: boolean;
}

/** Loads `.env` (if present) then builds a validated config. Explicit overrides win over env. */
export function loadConfig(
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): AppConfig {
  const envFile = path.resolve(process.cwd(), ".env");
  if (env === process.env && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }

  const fromEnv = {
    llmProvider: blank(env.LLM_PROVIDER),
    anthropicModel: blank(env.ANTHROPIC_MODEL),
    anthropicApiKey: blank(env.ANTHROPIC_API_KEY),
    fakeFailureRate: blank(env.FAKE_FAILURE_RATE),
    fakeLatencyMs: blank(env.FAKE_LATENCY_MS),
    llmMaxRetries: blank(env.LLM_MAX_RETRIES),
    concurrency: blank(env.PIPELINE_CONCURRENCY),
    outDir: blank(env.OUT_DIR),
    checkpointer: blank(env.CHECKPOINTER),
    email: {
      to: blank(env.EMAIL_TO),
      from: blank(env.EMAIL_FROM),
      smtpHost: blank(env.SMTP_HOST),
      smtpPort: blank(env.SMTP_PORT),
      smtpUser: blank(env.SMTP_USER),
      smtpPass: blank(env.SMTP_PASS),
      smtpSecure: blank(env.SMTP_SECURE),
    },
  };

  const merged = {
    ...stripUndefined(fromEnv),
    ...stripUndefined(overrides),
    email: { ...stripUndefined(fromEnv.email), ...stripUndefined(overrides.email ?? {}) },
  };

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  if (opts.requireModelCredentials !== false && parsed.data.llmProvider === "anthropic" && !parsed.data.anthropicApiKey) {
    throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY (or run with LLM_PROVIDER=fake).");
  }
  return parsed.data;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
