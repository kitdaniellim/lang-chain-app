# frontend — lang-chain-app

React 19 + Vite + TypeScript. Plain CSS (tokens in `src/styles/tokens.css`), no UI framework, dark theme.

```bash
npm install
cp .env.example .env        # VITE_API_URL, VITE_USE_MOCK
npm run dev                 # http://localhost:5173
npm run build               # tsc -b && vite build
npm test                    # vitest
```

Set `VITE_USE_MOCK=true` to run against the fixtures in `src/api/mock.ts` without a backend.
