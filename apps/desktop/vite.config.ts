import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  base: "./",
  root: path.resolve(__dirname, "src/renderer"),
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: false
  }
});
