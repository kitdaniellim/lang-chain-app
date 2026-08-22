// `npm run setup`: python venv + backend deps, frontend deps, and .env files. Safe to re-run.
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { BACKEND, FRONTEND, VENV_PYTHON, hasVenv, log, run, systemPython } from "./lib.mjs";

const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 20) {
  console.error(`Node ${process.versions.node} found; Node 20 or newer is required.`);
  process.exit(1);
}

const python = systemPython();
if (!python || !/Python 3\.(1[2-9]|[2-9]\d)/.test(python.version)) {
  console.error(`Python 3.12 or newer is required (found: ${python?.version ?? "none"}). Install it from python.org and re-run.`);
  process.exit(1);
}
log("setup", `Node ${process.versions.node}, ${python.version}`);

if (hasVenv()) {
  log("setup", "backend/.venv already exists, reusing it");
} else {
  log("setup", "creating backend/.venv");
  await run(python.cmd, [...python.args, "-m", "venv", ".venv"], { cwd: BACKEND });
}
log("setup", "installing backend dependencies");
await run(VENV_PYTHON, ["-m", "pip", "install", "-q", "--upgrade", "pip"], { cwd: BACKEND });
await run(VENV_PYTHON, ["-m", "pip", "install", "-q", "-r", "requirements.txt"], { cwd: BACKEND });

log("setup", "installing frontend dependencies");
await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: FRONTEND });

for (const dir of [BACKEND, FRONTEND]) {
  const target = path.join(dir, ".env");
  if (existsSync(target)) {
    log("setup", `${path.basename(dir)}/.env already exists, left untouched`);
  } else {
    copyFileSync(path.join(dir, ".env.example"), target);
    log("setup", `created ${path.basename(dir)}/.env from .env.example`);
  }
}

console.log(`
Setup complete.

  npm run dev        start the API (http://127.0.0.1:8000) and the UI (http://localhost:5173)

Optional, in backend/.env:
  ANTHROPIC_API_KEY  enables extraction and chat (console.anthropic.com)
  DATABASE_URL       Supabase Postgres; leave empty for the local SQLite file
`);
