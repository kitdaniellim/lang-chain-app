import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  // The single .env lives at the repository root; Vite only exposes VITE_* keys to the browser.
  envDir: "..",
  plugins: [react()],
  server: {
    port: 5173,
    // Dev: API calls stay same-origin and are proxied to uvicorn, so no CORS or VITE_API_URL is needed.
    proxy: Object.fromEntries(["/health", "/invoices", "/chat"].map((p) => [p, "http://127.0.0.1:8000"])),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
