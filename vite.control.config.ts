import { defineConfig } from "vite";

// Builds the page-injected control script (Tauri initialization_script).
// Output is checked in at src-tauri/injected/control.js and loaded by
// lib.rs via include_str!. Rebuild with: npm run build:control
export default defineConfig({
  build: {
    outDir: "src-tauri/injected",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: "src/control.ts",
      formats: ["iife"],
      name: "museLocalControl",
      fileName: () => "control.js",
    },
  },
});
