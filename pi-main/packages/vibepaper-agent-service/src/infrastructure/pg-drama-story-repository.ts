import type { QueryResultRow } from "pg";
import type { ContinuityFact, Episode, Foreshadow, Scene, StoryBible } from "../domain/drama-story.ts";
import type { SqlExecutor } from "./database.ts";
import { nextId } from "./ids.ts";

type BibleRow = QueryResultRow & {
	id: string;
	owner_id: string;
	title: string;
	canon: string;
	revision: number;
	status: StoryBible["status"];
};
type EpisodeRow = QueryResultRow & {
	id: string;
	owner_id: string;
	bible_id: string;
	episode_no: number;
	title: string;
	status: Episode["status"];
};
type SceneRow = QueryResultRow & {
	id: string;
	owner_id: string;
	episode_id: string;
	scene_no: number;
	summary: string;
	status: Scene["status"];
};
type FactRow = QueryResultRow & { id: string; owner_id: string; scene_id: string; statement: string };
type ForeshadowRow = QueryResultRow & {
	id: string;
	owner_id: string;
	scene_id: string;
	clue: string;
	payoff: string;
	status: Foreshadow["status"];
};

export class PgDramaStoryService {
	private readonly database: SqlExecutor;

	constructor(database: SqlExecutor) {
		this.database = database;
	}

	async createBible(input: { ownerId: string; title: string; canon: string }): Promise<StoryBible> {
		const bible: StoryBible = {
			id: nextId(),
			ownerId: input.ownerId,
			title: input.title.trim(),
			canon: input.canon.trim(),
			revision: 1,
			status: "draft",
		};
		try {
			await this.database.query(
				"INSERT INTO story_bibles (id, owner_id, title, canon, revision, status) VALUES ($1, $2, $3, $4, $5, $6)",
				[bible.id, bible.ownerId, bible.title, bible.canon, bible.revision, bible.status],
			);
		} catch (error) {
			if (isUniqueViolation(error)) throw new Error("CONFLICT");
			throw error;
		}
		return bible;
	}

	async getBible(id: string, ownerId: string): Promise<StoryBible> {
		const result = await this.database.query<BibleRow>(
			"SELECT id, owner_id, title, canon, revision, status FROM story_bibles WHERE id = $1 AND owner_id = $2",
			[id, ownerId],
		);
		const row = result.rows[0];
		if (!row) throw new Error("NOT_FOUND");
		return toBible(row);
	}

	async reviseCanon(id: string, ownerId: string, canon: string): Promise<StoryBible> {
		await this.getBible(id, ownerId);
		const result = await this.database.query<BibleRow>(
			`UPDATE story_bibles SET canon = $3, revision = revision + 1, updated_at = now()
			 WHERE id = $1 AND owner_id = $2
			 RETURNING id, owner_id, title, canon, revision, status`,
			[id, ownerId, canon.trim()],
		);
		const row = result.rows[0];
		if (!row) throw new Error("NOT_FOUND");
		return toBible(row);
	}

	async createEpisode(input: { ownerId: string; bibleId: string; number: number; title: string }): Promise<Episode> {
		await this.getBible(input.bibleId, input.ownerId);
		const episode: Episode = {
			id: nextId(),
			ownerId: input.ownerId,
			bibleId: input.bibleId,
			number: input.number,
			title: input.title.trim(),
			status: "draft",
		};
		try {
			await this.database.query(
				"INSERT INTO story_episodes (id, bible_id, owner_id, episode_no, title, status) VALUES ($1, $2, $3, $4, $5, $6)",
				[episode.id, episode.bibleId, episode.ownerId, episode.number, episode.title, episode.status],
			);
		} catch (error) {
			if (isUniqueViolation(error)) throw new Error("CONFLICT");
			throw error;
		}
		return episode;
	}

	async createScene(input: { ownerId: string; episodeId: string; number: number; summary: string }): Promise<Scene> {
		await this.requireEpisode(input.episodeId, input.ownerId);
		const scene: Scene = {
			id: nextId(),
			ownerId: input.ownerId,
			episodeId: input.episodeId,
			number: input.number,
			summary: input.summary.trim(),
			status: "draft",
		};
		try {
			await this.database.query(
				"INSERT INTO story_scenes (id, episode_id, owner_id, scene_no, summary, status) VALUES ($1, $2, $3, $4, $5, $6)",
				[scene.id, scene.episodeId, scene.ownerId, scene.number, scene.summary, scene.status],
			);
		} catch (error) {
			if (isUniqueViolation(error)) throw new Error("CONFLICT");
			throw error;
		}
		return scene;
	}

	async addContinuityFact(input: { ownerId: string; sceneId: string; statement: string }): Promise<ContinuityFact> {
		await this.requireScene(input.sceneId, input.ownerId);
		const fact: ContinuityFact = { id: nextId(), ...input, statement: input.statement.trim() };
		await this.database.query(
			"INSERT INTO continuity_facts (id, scene_id, owner_id, statement) VALUES ($1, $2, $3, $4)",
			[fact.id, fact.sceneId, fact.ownerId, fact.statement],
		);
		return fact;
	}

	async listContinuityFacts(sceneId: string, ownerId: string): Promise<readonly ContinuityFact[]> {
		await this.requireScene(sceneId, ownerId);
		const result = await this.database.query<FactRow>(
			"SELECT id, owner_id, scene_id, statement FROM continuity_facts WHERE scene_id = $1 AND owner_id = $2 ORDER BY id",
			[sceneId, ownerId],
		);
		return result.rows.map((row) => ({
			id: String(row.id),
			ownerId: String(row.owner_id),
			sceneId: String(row.scene_id),
			statement: row.statement,
		}));
	}

	async plantForeshadow(input: {
		ownerId: string;
		sceneId: string;
		clue: string;
		payoff: string;
	}): Promise<Foreshadow> {
		await this.requireScene(input.sceneId, input.ownerId);
		const foreshadow: Foreshadow = {
			id: nextId(),
			...input,
			clue: input.clue.trim(),
			payoff: input.payoff.trim(),
			status: "planted",
		};
		await this.database.query(
			"INSERT INTO foreshadows (id, scene_id, owner_id, clue, payoff, status) VALUES ($1, $2, $3, $4, $5, $6)",
			[foreshadow.id, foreshadow.sceneId, foreshadow.ownerId, foreshadow.clue, foreshadow.payoff, foreshadow.status],
		);
		return foreshadow;
	}

	async resolveForeshadow(id: string, ownerId: string): Promise<Foreshadow> {
		const result = await this.database.query<ForeshadowRow>(
			`UPDATE foreshadows SET status = 'resolved', resolved_at = now()
			 WHERE id = $1 AND owner_id = $2
			 RETURNING id, owner_id, scene_id, clue, payoff, status`,
			[id, ownerId],
		);
		const row = result.rows[0];
		if (!row) throw new Error("NOT_FOUND");
		return toForeshadow(row);
	}

	private async requireEpisode(id: string, ownerId: string): Promise<Episode> {
		const result = await this.database.query<EpisodeRow>(
			"SELECT id, owner_id, bible_id, episode_no, title, status FROM story_episodes WHERE id = $1 AND owner_id = $2",
			[id, ownerId],
		);
		const row = result.rows[0];
		if (!row) throw new Error("NOT_FOUND");
		return toEpisode(row);
	}

	private async requireScene(id: string, ownerId: string): Promise<Scene> {
		const result = await this.database.query<SceneRow>(
			"SELECT id, owner_id, episode_id, scene_no, summary, status FROM story_scenes WHERE id = $1 AND owner_id = $2",
			[id, ownerId],
		);
		const row = result.rows[0];
		if (!row) throw new Error("NOT_FOUND");
		return toScene(row);
	}
}

function toBible(row: BibleRow): StoryBible {
	return {
		id: String(row.id),
		ownerId: String(row.owner_id),
		title: row.title,
		canon: row.canon,
		revision: Number(row.revision),
		status: row.status,
	};
}

function toEpisode(row: EpisodeRow): Episode {
	return {
		id: String(row.id),
		ownerId: String(row.owner_id),
		bibleId: String(row.bible_id),
		number: Number(row.episode_no),
		title: row.title,
		status: row.status,
	};
}

function toScene(row: SceneRow): Scene {
	return {
		id: String(row.id),
		ownerId: String(row.owner_id),
		episodeId: String(row.episode_id),
		number: Number(row.scene_no),
		summary: row.summary,
		status: row.status,
	};
}

function toForeshadow(row: ForeshadowRow): Foreshadow {
	return {
		id: String(row.id),
		ownerId: String(row.owner_id),
		sceneId: String(row.scene_id),
		clue: row.clue,
		payoff: row.payoff,
		status: row.status,
	};
}

function isUniqueViolation(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
