import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		testTimeout: 10000,
	},
	ssr: {
		noExternal: ["ffmpeg-static", "execa"], // Treat these as ESM
	},
});
