import { settings, validateStartupConfig } from "./config.ts";
import { PgDatabase } from "./infrastructure/database.ts";
import { applyMigrations, migrationDirectoryFromUrl } from "./infrastructure/migrations.ts";

if (!settings.databaseUrl) {
	throw new Error("VIBEPAPER_DATABASE_URL 未配置，无法执行迁移");
}
validateStartupConfig(settings);

const database = new PgDatabase(settings.databaseUrl);
try {
	await applyMigrations(database, migrationDirectoryFromUrl(import.meta.url));
} finally {
	await database.close();
}
