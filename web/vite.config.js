import { defineConfig } from "vite";

export default defineConfig({
  base: "/puppetry/",
  define: {
    global: "globalThis",
  },
});
