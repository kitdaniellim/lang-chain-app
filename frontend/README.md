# frontend

React 19 + Vite + TypeScript, plain CSS tokens, dark theme. Run everything from the repository root:

```bash
npm run setup   # once
npm run dev     # API + UI
```

Frontend-only commands (from this folder): `npm run dev`, `npm test`, `npm run typecheck`, `npm run build`.

Configuration lives in the repository-root `.env` (`envDir: ".."` in `vite.config.ts`; only `VITE_*` keys reach the
browser): `VITE_API_URL` (default `http://127.0.0.1:8000`) and `VITE_USE_MOCK=true` to work on the UI without a
backend (serves `src/api/mock.ts`).
