import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { copyFile } from "node:fs/promises";

export default defineConfig({
  plugins: [react(), {
    name: "release-legal-documents",
    async closeBundle() {
      await Promise.all([
        copyFile(resolve(import.meta.dirname, "LICENSE"), resolve(import.meta.dirname, "dist/LICENSE")),
        copyFile(resolve(import.meta.dirname, "THIRD_PARTY_NOTICES.md"), resolve(import.meta.dirname, "dist/THIRD_PARTY_NOTICES.md")),
        copyFile(resolve(import.meta.dirname, "docs/PRIVACY.md"), resolve(import.meta.dirname, "dist/PRIVACY.md"))
      ]);
    }
  }],
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
