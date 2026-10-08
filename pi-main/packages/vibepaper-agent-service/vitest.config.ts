import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const agentSourceIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const aiSourceIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiCompatSource = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const telemetrySourceIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		silent: "passed-only",
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSourceIndex },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSourceIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: aiCompatSource },
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: telemetrySourceIndex },
		],
	},
});
