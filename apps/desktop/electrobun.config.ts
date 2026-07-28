import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "ccflare",
		identifier: "sh.snipeship.ccflare",
		version: "0.1.0",
	},
	build: {
		useAsar: false,
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {},
		copy: {
			".desktop-runtime": "desktop-runtime",
		},
		mac: {
			codesign: false,
			notarize: false,
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
