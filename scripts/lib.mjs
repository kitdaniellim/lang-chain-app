// Shared helpers for the root scripts: paths, the venv's python, and a spawn that streams output.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BACKEND = path.join(ROOT, "backend");
export const FRONTEND = path.join(ROOT, "frontend");
export const IS_WINDOWS = process.platform === "win32";

/** Python inside backend/.venv (created by `npm run setup`). */
export const VENV_PYTHON = IS_WINDOWS
  ? path.join(BACKEND, ".venv", "Scripts", "python.exe")
  : path.join(BACKEND, ".venv", "bin", "python");

/** The system python used to create the venv: py launcher on Windows, python3 elsewhere. */
export function systemPython() {
  const candidates = IS_WINDOWS ? [["py", ["-3"]], ["python", []]] : [["python3", []], ["python", []]];
  for (const [cmd, args] of candidates) {
    const probe = spawnSync(cmd, [...args, "--version"], { encoding: "utf8" });
    if (probe.status === 0) return { cmd, args, version: (probe.stdout || probe.stderr).trim() };
  }
  return null;
}

export function hasVenv() {
  return existsSync(VENV_PYTHON);
}

const COLORS = { backend: "\x1b[36m", frontend: "\x1b[35m", setup: "\x1b[33m", reset: "\x1b[0m" };

export function log(scope, message) {
  const color = COLORS[scope] ?? "";
  console.log(`${color}[${scope}]${COLORS.reset} ${message}`);
}

/** Run a command to completion, streaming output; rejects on a non-zero exit. */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: IS_WINDOWS && cmd === "npm", ...opts });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`))));
  });
}
