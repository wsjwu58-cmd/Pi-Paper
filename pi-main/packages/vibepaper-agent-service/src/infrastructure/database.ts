import { Pool, type PoolClient, type QueryResultRow } from "pg";

export interface SqlExecutor {
	query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export class PgDatabase implements SqlExecutor {
	readonly pool: Pool;

	constructor(connectionString: string) {
		this.pool = new Pool({ connectionString, max: 10 });
	}

	async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
		return await this.pool.query<T>(text, values);
	}

	async transaction<T>(operation: (client: SqlExecutor) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await operation(new PgClientExecutor(client));
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}

class PgClientExecutor implements SqlExecutor {
	private readonly client: PoolClient;

	constructor(client: PoolClient) {
		this.client = client;
	}

	async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
		return await this.client.query<T>(text, values);
	}
}
