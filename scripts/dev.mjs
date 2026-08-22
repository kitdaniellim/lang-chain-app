// `npm run dev`: backend + frontend in one terminal with prefixed output; Ctrl-C stops both.
import { spawn } from "node:child_process";
import { BACKEND, FRONTEND, IS_WINDOWS, VENV_PYTHON, hasVenv, log } from "./lib.mjs";

if (!hasVenv()) {
  console.error("backend/.venv is missing. Run `npm run setup` first.");
  process.exit(1);
}

const children = [];

function start(scope, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: IS_WINDOWS && cmd === "npm" });
  const prefix = (line) => log(scope, line);
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines.filter((line) => line.trim()).forEach(prefix);
    });
  }
  child.on("exit", (code) => {
    log(scope, `exited with ${code ?? "signal"}`);
    stopAll();
    process.exit(code ?? 1);
  });
  children.push(child);
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode === null) {
      // On Windows a plain kill leaves uvicorn's reloader running; taskkill takes the tree.
      if (IS_WINDOWS) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", () => {
  log("setup", "stopping");
  stopAll();
  process.exit(0);
});
process.on("SIGTERM", stopAll);

const backendOnly = process.argv.includes("--backend-only");
start("backend", VENV_PYTHON, ["-m", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"], BACKEND);
if (!backendOnly) start("frontend", "npm", ["run", "-s", "dev"], FRONTEND);
log("setup", "API on http://127.0.0.1:8000, UI on the port Vite prints below (5173 unless busy). Ctrl-C stops both.");
