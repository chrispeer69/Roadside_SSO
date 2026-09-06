import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.API_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(["/api", "/oauth", "/launch", "/.well-known"].map((p) => [p, { target: api, changeOrigin: false }])),
  },
  build: { outDir: "dist", sourcemap: false },
});
