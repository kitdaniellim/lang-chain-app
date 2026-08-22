// `npm test`: backend pytest, then frontend typecheck + vitest.
import { BACKEND, FRONTEND, VENV_PYTHON, hasVenv, log, run } from "./lib.mjs";

if (!hasVenv()) {
  console.error("backend/.venv is missing. Run `npm run setup` first.");
  process.exit(1);
}
log("setup", "backend: pytest");
await run(VENV_PYTHON, ["-m", "pytest", "-q"], { cwd: BACKEND });
log("setup", "frontend: typecheck + vitest");
await run("npm", ["run", "-s", "typecheck"], { cwd: FRONTEND });
await run("npm", ["test", "--", "--run"], { cwd: FRONTEND });
log("setup", "all green");
