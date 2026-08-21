import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const ANTHROPIC_NO_KEY = { LLM_PROVIDER: "anthropic" } as NodeJS.ProcessEnv;

describe("loadConfig — model credentials", () => {
  it("rejects the anthropic provider without a key by default", () => {
    expect(() => loadConfig({}, ANTHROPIC_NO_KEY)).toThrow(/requires ANTHROPIC_API_KEY/);
  });

  it("allows a key-less anthropic config for commands that never call a model", () => {
    const config = loadConfig({}, ANTHROPIC_NO_KEY, { requireModelCredentials: false });
    expect(config.llmProvider).toBe("anthropic");
    expect(config.anthropicApiKey).toBeUndefined();
  });

  it("still validates everything else when credentials are not required", () => {
    expect(() => loadConfig({ concurrency: 0 }, ANTHROPIC_NO_KEY, { requireModelCredentials: false })).toThrow(
      /Invalid configuration/,
    );
  });

  it("reads the environment and lets explicit overrides win", () => {
    const env = { LLM_PROVIDER: "fake", OUT_DIR: "from-env", PIPELINE_CONCURRENCY: "7" } as NodeJS.ProcessEnv;
    expect(loadConfig({}, env).outDir).toBe("from-env");
    expect(loadConfig({}, env).concurrency).toBe(7);
    expect(loadConfig({ outDir: "from-args" }, env).outDir).toBe("from-args");
  });
});
