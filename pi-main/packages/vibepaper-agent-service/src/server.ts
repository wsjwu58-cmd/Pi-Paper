import { Redis } from "ioredis";

import { createApp } from "./api/app.ts";
import { DailyMemoryService } from "./application/daily-memory-service.ts";
import { settings, validateStartupConfig } from "./config.ts";
import { PgDatabase } from "./infrastructure/database.ts";
import { configureIdGenerator } from "./infrastructure/ids.ts";
import { applyMigrations, migrationDirectoryFromUrl } from "./infrastructure/migrations.ts";
import { NacosRegistrar } from "./infrastructure/nacos.ts";
import { RedisDailyMemoryRepository } from "./infrastructure/redis-daily-memory-repository.ts";
import { RedisMemoryUpdateQueue } from "./infrastructure/redis-memory-update-queue.ts";

if (!settings.databaseUrl) {
	throw new Error("VIBEPAPER_DATABASE_URL 未配置，agent-service 无法启动");
}
validateStartupConfig(settings);

const database = new PgDatabase(settings.databaseUrl);
configureIdGenerator(settings.workerId, settings.datacenterId);
await applyMigrations(database, migrationDirectoryFromUrl(import.meta.url));
const redis = settings.redisUrl ? new Redis(settings.redisUrl, { maxRetriesPerRequest: null }) : undefined;
const dailyRedis = redis?.duplicate();
const dailyMemoryService = dailyRedis
	? new DailyMemoryService(new RedisDailyMemoryRepository(dailyRedis))
	: undefined;
const memoryUpdateQueue = redis ? new RedisMemoryUpdateQueue(redis) : undefined;
const app = createApp({ config: settings, database, dailyMemoryService, memoryUpdateQueue });
const nacos = new NacosRegistrar(settings, settings.port);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void (async () => {
			await nacos.stop();
			await app.close();
			await dailyRedis?.quit();
			await database.close();
		})();
	});
}

await app.listen({ host: "0.0.0.0", port: settings.port });
await nacos.start();
