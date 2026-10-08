import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { QueryResultRow } from "pg";

import type { SqlExecutor } from "./database.ts";

export interface MigrationDatabase extends SqlExecutor {
	transaction<T>(operation: (client: SqlExecutor) => Promise<T>): Promise<T>;
}

export function migrationDirectoryFromUrl(serverUrl: string): string {
	return fileURLToPath(new URL("../migrations/", serverUrl));
}

type MigrationRow = QueryResultRow & { version: string; checksum: string };

const LEGACY_BASELINE_CHECKSUM = "f7b5d9e13ae951f083474afef84299e6b68825cce8e4c6f6332eaf3ec65bb2f3";

export function isKnownLegacyMigrationChecksum(version: string, checksum: string): boolean {
	return version === "001_baseline.sql" && checksum === LEGACY_BASELINE_CHECKSUM;
}

export async function applyMigrations(database: MigrationDatabase, directory: string): Promise<void> {
	await database.transaction(async (client) => {
		await client.query(
			`CREATE TABLE IF NOT EXISTS schema_migrations (
				version VARCHAR(255) PRIMARY KEY,
				filename VARCHAR(255) NOT NULL DEFAULT '',
				checksum VARCHAR(64) NOT NULL,
				applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`,
		);
		await client.query("ALTER TABLE schema_migrations ALTER COLUMN filename SET DEFAULT ''");
		const existing = await client.query<MigrationRow>(
			"SELECT version, checksum FROM schema_migrations ORDER BY version",
		);
		const checksums = new Map(existing.rows.map((row) => [row.version, row.checksum]));
		const files = (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && /^\d+_.+\.sql$/.test(entry.name))
			.map((entry) => entry.name)
			.sort();

		for (const file of files) {
			const sql = await readFile(join(directory, file), "utf8");
			const checksum = createHash("sha256").update(sql).digest("hex");
			const previous = checksums.get(file);
			if (previous && previous !== checksum && !isKnownLegacyMigrationChecksum(file, previous))
				throw new Error("MIGRATION_CHECKSUM_MISMATCH");
			if (previous) continue;
			await client.query(sql);
			await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [file, checksum]);
		}
	});
}
