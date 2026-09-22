import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, "src/background/index.ts"),
        content: resolve(import.meta.dirname, "src/content/index.ts"),
        offscreen: resolve(import.meta.dirname, "offscreen.html"),
        options: resolve(import.meta.dirname, "options.html")
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    },
    sourcemap: false
  },
  worker: { format: "es" },
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] }
});
