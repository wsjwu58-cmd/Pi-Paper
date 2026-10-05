import { describe, expect, it } from "vitest";

import { loadConfig, validateStartupConfig } from "../src/config.ts";

describe("production startup and routing contracts", () => {
	it("fails closed when production secrets and service credentials are absent", () => {
		const config = loadConfig({ VIBEPAPER_ENVIRONMENT: "production" });
		expect(() => validateStartupConfig(config)).toThrow("VIBEPAPER_INTERNAL_SERVICE_TOKEN");
	});

	it("requires valid explicit Snowflake coordinates", () => {
		const config = loadConfig({
			VIBEPAPER_ENVIRONMENT: "production",
			VIBEPAPER_INTERNAL_SERVICE_TOKEN: "internal",
			VIBEPAPER_CONFIRM_SIGNING_SECRET: "confirm",
			VIBEPAPER_NACOS_USERNAME: "nacos",
			VIBEPAPER_NACOS_PASSWORD: "nacos",
			VIBEPAPER_NACOS_REGISTER_IP: "127.0.0.1",
			VIBEPAPER_DATABASE_URL: "postgres://localhost/agent",
			VIBEPAPER_SNOWFLAKE_WORKER_ID: "4",
			VIBEPAPER_SNOWFLAKE_DATACENTER_ID: "2",
		});
		expect(() => validateStartupConfig(config)).not.toThrow();
	});

});
