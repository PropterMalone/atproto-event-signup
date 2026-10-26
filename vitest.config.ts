import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		environment: "node",
		passWithNoTests: true,
		coverage: {
			provider: "v8",
			include: [
				"src/server/store.ts",
				"src/server/policy.ts",
				"src/server/print.ts",
				"src/shared/handle.ts",
			],
			thresholds: { lines: 95, functions: 95, statements: 95, branches: 95 },
		},
	},
});
