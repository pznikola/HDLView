import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => ({
  root: "ui",
  publicDir: "../public",
  plugins: [react()],
  clearScreen: false,
  server: { strictPort: true },
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "react/jsx-runtime",
      "elkjs/lib/elk-api.js",
      "@tauri-apps/api/core",
    ],
  },
  // Rollup's argument analysis recurses pathologically on the generated worker API.
  // Keep its small wrapper intact; ELK itself is an unmodified static worker asset.
  build: {
    outDir: mode === "e2e" ? "../dist-test" : "../dist",
    emptyOutDir: true,
    rollupOptions: { treeshake: false },
  },
  worker: { format: "es", rollupOptions: { treeshake: false } },
}));
