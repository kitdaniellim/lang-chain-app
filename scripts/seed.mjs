// `npm run seed`: wipe and re-seed the configured database (SQLite file or Supabase).
import { BACKEND, VENV_PYTHON, hasVenv, run } from "./lib.mjs";

if (!hasVenv()) {
  console.error("backend/.venv is missing. Run `npm run setup` first.");
  process.exit(1);
}
await run(VENV_PYTHON, ["-m", "app.seed", "--force"], { cwd: BACKEND });
