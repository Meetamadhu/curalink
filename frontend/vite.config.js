import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true,
        // First chat can take several minutes (OpenAlex + PubMed + trials + local LLM)
        timeout: 600_000,
        proxyTimeout: 600_000,
      },
    },
  },
});
