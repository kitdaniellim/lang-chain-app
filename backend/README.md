# backend

FastAPI + SQLAlchemy + LangChain. Run everything from the repository root:

```bash
npm run setup   # once: creates .venv here and installs requirements.txt
npm run dev     # uvicorn on http://127.0.0.1:8000 (+ the UI)
npm test        # pytest (no network) + frontend checks
```

Backend-only, from this folder with the venv's Python (`.venv/Scripts/python` on Windows, `.venv/bin/python` elsewhere):
`-m uvicorn app.main:app --reload --port 8000`, `-m pytest -q`, `-m app.seed --force`.

Settings come from `.env` (see `.env.example`): `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `DATABASE_URL`.
Module map and API are in the root README.
