import { defineConfig } from "vite";

export default defineConfig({
    build: {
        rollupOptions: {
            input: {
                content: "src/content.ts",
                pageBridge: "src/page-bridge.ts",
                popup: "src/popup.ts",
                background: "src/background.ts",
                offscreen: "src/offscreen.ts",
                options: "src/options.ts"
            },
            output: {
                entryFileNames: "[name].js"
            }
        }
    }
});
