import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { SnowflakeIdGenerator } from "../src/infrastructure/ids.ts";
import { applyMigrations, type MigrationDatabase } from "../src/infrastructure/migrations.ts";

class FakeMigrationDatabase implements MigrationDatabase {
	readonly applied = new Map<string, string>();
	readonly statements: string[] = [];

	async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
		this.statements.push(text);
		if (text.startsWith("SELECT version, checksum FROM schema_migrations")) {
			return {
				rows: [...this.applied].map(([version, checksum]) => ({ version, checksum })) as unknown as T[],
			};
		}
		if (text.startsWith("INSERT INTO schema_migrations")) {
			this.applied.set(String(values[0]), String(values[1]));
		}
		return { rows: [] };
	}

	async transaction<T>(operation: (client: MigrationDatabase) => Promise<T>): Promise<T> {
		return await operation(this);
	}
}

describe("versioned migrations", () => {
	it("applies migrations once and rejects a changed checksum", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-agent-migrations-"));
		await mkdir(join(directory, "nested"));
		await writeFile(join(directory, "001_first.sql"), "CREATE TABLE first_table (id bigint);");
		const database = new FakeMigrationDatabase();

		await applyMigrations(database, directory);
		await applyMigrations(database, directory);
		expect(database.applied.has("001_first.sql")).toBe(true);
		expect(database.statements.filter((statement) => statement.startsWith("CREATE TABLE first_table")).length).toBe(
			1,
		);

		await writeFile(join(directory, "001_first.sql"), "CREATE TABLE first_table (id bigint, changed boolean);");
		await expect(applyMigrations(database, directory)).rejects.toThrow("MIGRATION_CHECKSUM_MISMATCH");
	});

	it("uses explicit worker and datacenter bits without PID-derived state", () => {
		const generator = new SnowflakeIdGenerator(7, 9);
		const ids = new Set(Array.from({ length: 4097 }, () => generator.next(1_700_000_000_000)));
		expect(ids).toHaveLength(4097);
		const monotonic = new SnowflakeIdGenerator(7, 9);
		expect(monotonic.next(1_700_000_000_001)).not.toBe(monotonic.next(1_700_000_000_002));
	});

	it("rejects clock rollback instead of reusing an ID", () => {
		const generator = new SnowflakeIdGenerator(1, 1);
		generator.next(1_700_000_000_001);
		expect(() => generator.next(1_700_000_000_000)).toThrow("SNOWFLAKE_CLOCK_ROLLBACK");
	});
});
