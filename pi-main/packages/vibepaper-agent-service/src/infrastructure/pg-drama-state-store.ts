import type {
	CharacterProfile,
	CharacterReferencePack,
	DramaSeries,
	DramaStateStore,
	KeyframeNodeDraft,
	KeyframeRender,
	RenderLineage,
	ShotCharacterBinding,
	ShotSpec,
	VideoNodeDraft,
} from "../domain/drama-state.ts";
import { DramaDomainError } from "../domain/drama-state.ts";
import type { SqlExecutor } from "./database.ts";

type SeriesRow = {
	id: string;
	canvas_id: string;
	owner_id: string | null;
	active_canon_revision: number;
	format: unknown;
};
type CharacterRow = {
	id: string;
	series_id: string;
	name: string;
	identity_anchors: unknown;
	active_look_revision: number;
	voice_id: string;
};
type ReferencePackRow = {
	id: string;
	character_id: string;
	look_revision: number;
	status: CharacterReferencePack["status"];
	front_asset_id: string;
	side_asset_id: string;
	back_asset_id: string;
	expression_asset_ids: unknown;
};
type ShotRow = {
	id: string;
	series_id: string;
	episode_no: number;
	shot_no: number;
	duration_seconds: number;
	character_bindings: unknown;
	prompt_revision: number;
};
type KeyframeRow = { id: string; shot_id: string; status: KeyframeRender["status"]; reference_pack_ids: unknown };
type LineageRow = { id: string; shot_id: string; keyframe_render_id: string; status: RenderLineage["status"] };

function asStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new DramaDomainError("INVALID_STATE", `${field}状态格式无效`);
	}
	return value;
}

function asBindings(value: unknown): ShotCharacterBinding[] {
	if (!Array.isArray(value)) throw new DramaDomainError("INVALID_STATE", "镜头角色绑定状态格式无效");
	const bindings: ShotCharacterBinding[] = [];
	for (const item of value) {
		if (
			typeof item !== "object" ||
			item === null ||
			!("characterId" in item) ||
			!("lookRevision" in item) ||
			typeof item.characterId !== "string" ||
			typeof item.lookRevision !== "number"
		) {
			throw new DramaDomainError("INVALID_STATE", "镜头角色绑定状态格式无效");
		}
		bindings.push({ characterId: item.characterId, lookRevision: item.lookRevision });
	}
	return bindings;
}

function requireNonBlank(value: string, field: string): void {
	if (!value.trim()) throw new DramaDomainError("INVALID_INPUT", `${field}不能为空`);
}

function validateCharacter(character: CharacterProfile): void {
	requireNonBlank(character.name, "角色名");
	requireNonBlank(character.voiceId, "角色 voiceId");
	if (character.identityAnchors.length < 3 || character.identityAnchors.length > 5) {
		throw new DramaDomainError("INVALID_IDENTITY_ANCHORS", "角色必须包含 3-5 条不可变外形锚点");
	}
	if (new Set(character.identityAnchors).size !== character.identityAnchors.length) {
		throw new DramaDomainError("INVALID_IDENTITY_ANCHORS", "角色外形锚点不能重复");
	}
}

function validateReferencePack(pack: CharacterReferencePack): void {
	for (const [value, field] of [
		[pack.frontAssetId, "角色正面参考图"],
		[pack.sideAssetId, "角色侧面参考图"],
		[pack.backAssetId, "角色背面参考图"],
	] as const) {
		requireNonBlank(value, field);
	}
	if (pack.expressionAssetIds.length === 0) {
		throw new DramaDomainError("INCOMPLETE_REFERENCE_PACK", "角色参考包缺少表情表");
	}
}

export class PgDramaStateStore implements DramaStateStore {
	private readonly database: SqlExecutor;

	constructor(database: SqlExecutor) {
		this.database = database;
	}

	async createSeries(series: DramaSeries, ownerId?: string): Promise<void> {
		if (series.format.aspectRatio !== "9:16") {
			throw new DramaDomainError("INVALID_FORMAT", "竖屏短剧必须使用 9:16");
		}
		try {
			await this.database.query(
				"INSERT INTO drama_series (id, canvas_id, owner_id, active_canon_revision, format) VALUES ($1, $2, $3, $4, $5::jsonb)",
				[
					series.id,
					series.canvasId,
					ownerId ?? series.ownerId ?? null,
					series.activeCanonRevision,
					JSON.stringify(series.format),
				],
			);
		} catch (error) {
			if (isUniqueViolation(error)) throw new DramaDomainError("CONFLICT", "短剧系列已存在");
			throw error;
		}
	}

	async createCharacter(character: CharacterProfile, ownerId?: string): Promise<void> {
		validateCharacter(character);
		await this.requireSeries(character.seriesId, ownerId);
		try {
			await this.database.query(
				`INSERT INTO drama_characters
					(id, series_id, name, identity_anchors, active_look_revision, voice_id)
				 VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
				[
					character.id,
					character.seriesId,
					character.name,
					JSON.stringify(character.identityAnchors),
					character.activeLookRevision,
					character.voiceId,
				],
			);
		} catch (error) {
			if (isUniqueViolation(error)) throw new DramaDomainError("CONFLICT", "角色已存在");
			throw error;
		}
	}

	async addReferencePack(pack: CharacterReferencePack, ownerId?: string): Promise<void> {
		const character = await this.requireCharacter(pack.characterId, ownerId);
		if (pack.lookRevision !== character.activeLookRevision) {
			throw new DramaDomainError("VERSION_CONFLICT", "角色参考包不是当前 Look revision");
		}
		if (pack.status === "approved") validateReferencePack(pack);
		try {
			await this.database.query(
				`INSERT INTO drama_reference_packs
					(id, character_id, look_revision, status, front_asset_id, side_asset_id, back_asset_id, expression_asset_ids)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
				[
					pack.id,
					pack.characterId,
					pack.lookRevision,
					pack.status,
					pack.frontAssetId,
					pack.sideAssetId,
					pack.backAssetId,
					JSON.stringify(pack.expressionAssetIds),
				],
			);
		} catch (error) {
			if (isUniqueViolation(error)) throw new DramaDomainError("CONFLICT", "角色参考包已存在");
			throw error;
		}
	}

	async createShot(shot: ShotSpec, ownerId?: string): Promise<void> {
		const series = await this.requireSeries(shot.seriesId, ownerId);
		if (
			shot.durationSeconds < series.format.minShotDurationSeconds ||
			shot.durationSeconds > series.format.maxShotDurationSeconds
		) {
			throw new DramaDomainError("INVALID_SHOT_DURATION", "竖屏短剧单镜时长必须在 2-5 秒之间");
		}
		for (const binding of shot.characterBindings) {
			const character = await this.requireCharacter(binding.characterId, ownerId);
			if (character.seriesId !== shot.seriesId || character.activeLookRevision !== binding.lookRevision) {
				throw new DramaDomainError("INVALID_CHARACTER_BINDING", "镜头未绑定系列当前角色 Look revision");
			}
		}
		try {
			await this.database.query(
				`INSERT INTO drama_shots
					(id, series_id, episode_no, shot_no, duration_seconds, character_bindings, prompt_revision)
				 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
				[
					shot.id,
					shot.seriesId,
					shot.episodeNo,
					shot.shotNo,
					shot.durationSeconds,
					JSON.stringify(shot.characterBindings),
					shot.promptRevision,
				],
			);
		} catch (error) {
			if (isUniqueViolation(error)) throw new DramaDomainError("CONFLICT", "镜头已存在");
			throw error;
		}
	}

	async prepareKeyframeNode(shotId: string, ownerId?: string): Promise<KeyframeNodeDraft> {
		const shot = await this.requireShot(shotId, ownerId);
		const packs = await Promise.all(
			shot.characterBindings.map(async (binding) => await this.resolveReferencePack(binding)),
		);
		return {
			nodeType: "image",
			creativeType: "keyframe",
			shotId: shot.id,
			referencePackIds: packs.map((pack) => pack.id),
			referenceAssetIds: packs.flatMap((pack) => [
				pack.frontAssetId,
				pack.sideAssetId,
				pack.backAssetId,
				...pack.expressionAssetIds,
			]),
		};
	}

	async recordKeyframe(render: KeyframeRender, ownerId?: string): Promise<void> {
		const expected = await this.prepareKeyframeNode(render.shotId, ownerId);
		if (render.status === "accepted" && !sameIds(render.referencePackIds, expected.referencePackIds)) {
			throw new DramaDomainError("MISSING_CHARACTER_REFERENCE", "关键帧未绑定当前角色参考包");
		}
		await this.database.query(
			"INSERT INTO drama_keyframes (id, shot_id, status, reference_pack_ids) VALUES ($1, $2, $3, $4::jsonb)",
			[render.id, render.shotId, render.status, JSON.stringify(render.referencePackIds)],
		);
	}

	async prepareVideoNode(shotId: string, ownerId?: string): Promise<VideoNodeDraft> {
		const expected = await this.prepareKeyframeNode(shotId, ownerId);
		const result = await this.database.query<KeyframeRow>(
			"SELECT id, shot_id, status, reference_pack_ids FROM drama_keyframes WHERE shot_id = $1 AND status = 'accepted' ORDER BY created_at DESC LIMIT 1",
			[shotId],
		);
		const keyframe = result.rows[0];
		if (!keyframe) throw new DramaDomainError("KEYFRAME_NOT_ACCEPTED", "视频生成必须引用已接受的关键帧");
		if (!sameIds(asStringArray(keyframe.reference_pack_ids, "关键帧参考包"), expected.referencePackIds)) {
			throw new DramaDomainError("MISSING_CHARACTER_REFERENCE", "视频生成缺少当前角色参考包");
		}
		return {
			nodeType: "video",
			creativeType: "clip",
			shotId,
			keyframeRenderId: keyframe.id,
			referencePackIds: expected.referencePackIds,
		};
	}

	async recordLineage(lineage: RenderLineage, ownerId?: string): Promise<void> {
		await this.requireShot(lineage.shotId, ownerId);
		const keyframe = await this.database.query<KeyframeRow>(
			"SELECT id, shot_id, status, reference_pack_ids FROM drama_keyframes WHERE id = $1",
			[lineage.keyframeRenderId],
		);
		if (!keyframe.rows[0]) throw new DramaDomainError("NOT_FOUND", "关键帧不存在");
		await this.database.query(
			"INSERT INTO drama_render_lineages (id, shot_id, keyframe_render_id, status) VALUES ($1, $2, $3, $4)",
			[lineage.id, lineage.shotId, lineage.keyframeRenderId, lineage.status],
		);
	}

	async markLineagesStaleForCharacter(characterId: string, ownerId?: string): Promise<readonly string[]> {
		const result = await this.database.query<LineageRow & { character_bindings: unknown }>(
			`SELECT lineage.id, lineage.shot_id, lineage.keyframe_render_id, lineage.status, shot.character_bindings
				 FROM drama_render_lineages lineage JOIN drama_shots shot ON shot.id = lineage.shot_id
				 JOIN drama_series series ON series.id = shot.series_id
				 WHERE lineage.status <> 'stale' AND ($1::bigint IS NULL OR series.owner_id = $1::bigint)`,
			[ownerId ?? null],
		);
		const ids = result.rows
			.filter((lineage) =>
				asBindings(lineage.character_bindings).some((binding) => binding.characterId === characterId),
			)
			.map((lineage) => lineage.id);
		if (ids.length > 0) {
			await this.database.query(
				"UPDATE drama_render_lineages SET status = 'stale', updated_at = now() WHERE id = ANY($1::varchar[])",
				[ids],
			);
		}
		return ids;
	}

	private async requireSeries(id: string, ownerId?: string): Promise<DramaSeries> {
		const result = await this.database.query<SeriesRow>(
			"SELECT id, canvas_id, owner_id, active_canon_revision, format FROM drama_series WHERE id = $1 AND ($2::bigint IS NULL OR owner_id = $2::bigint)",
			[id, ownerId ?? null],
		);
		const row = result.rows[0];
		if (!row || typeof row.format !== "object" || row.format === null || Array.isArray(row.format)) {
			throw new DramaDomainError("NOT_FOUND", "短剧系列不存在");
		}
		const format = row.format as Record<string, unknown>;
		if (
			format.aspectRatio !== "9:16" ||
			typeof format.targetDurationSeconds !== "number" ||
			typeof format.minShotCount !== "number" ||
			typeof format.maxShotCount !== "number" ||
			typeof format.minShotDurationSeconds !== "number" ||
			typeof format.maxShotDurationSeconds !== "number" ||
			format.keyframeFirst !== true ||
			typeof format.id !== "string"
		) {
			throw new DramaDomainError("INVALID_STATE", "短剧规格状态无效");
		}
		return {
			id: row.id,
			ownerId: row.owner_id ?? undefined,
			canvasId: row.canvas_id,
			activeCanonRevision: row.active_canon_revision,
			format: format as unknown as DramaSeries["format"],
		};
	}

	private async requireCharacter(id: string, ownerId?: string): Promise<CharacterProfile> {
		const result = await this.database.query<CharacterRow>(
			"SELECT character.id, character.series_id, character.name, character.identity_anchors, character.active_look_revision, character.voice_id FROM drama_characters character JOIN drama_series series ON series.id = character.series_id WHERE character.id = $1 AND ($2::bigint IS NULL OR series.owner_id = $2::bigint)",
			[id, ownerId ?? null],
		);
		const row = result.rows[0];
		if (!row) throw new DramaDomainError("NOT_FOUND", "角色不存在");
		return {
			id: row.id,
			seriesId: row.series_id,
			name: row.name,
			identityAnchors: asStringArray(row.identity_anchors, "角色外形锚点"),
			activeLookRevision: row.active_look_revision,
			voiceId: row.voice_id,
		};
	}

	private async requireShot(id: string, ownerId?: string): Promise<ShotSpec> {
		const result = await this.database.query<ShotRow>(
			"SELECT shot.id, shot.series_id, shot.episode_no, shot.shot_no, shot.duration_seconds, shot.character_bindings, shot.prompt_revision FROM drama_shots shot JOIN drama_series series ON series.id = shot.series_id WHERE shot.id = $1 AND ($2::bigint IS NULL OR series.owner_id = $2::bigint)",
			[id, ownerId ?? null],
		);
		const row = result.rows[0];
		if (!row) throw new DramaDomainError("NOT_FOUND", "镜头不存在");
		return {
			id: row.id,
			seriesId: row.series_id,
			episodeNo: row.episode_no,
			shotNo: row.shot_no,
			durationSeconds: row.duration_seconds,
			characterBindings: asBindings(row.character_bindings),
			promptRevision: row.prompt_revision,
		};
	}

	private async resolveReferencePack(binding: ShotCharacterBinding): Promise<CharacterReferencePack> {
		const result = await this.database.query<ReferencePackRow>(
			`SELECT id, character_id, look_revision, status, front_asset_id, side_asset_id, back_asset_id, expression_asset_ids
			 FROM drama_reference_packs WHERE character_id = $1 AND look_revision = $2 AND status = 'approved'`,
			[binding.characterId, binding.lookRevision],
		);
		if (result.rows.length === 0) {
			throw new DramaDomainError("MISSING_CHARACTER_REFERENCE", "人物镜头缺少已批准角色参考包");
		}
		if (result.rows.length > 1) {
			throw new DramaDomainError("CHARACTER_REFERENCE_AMBIGUOUS", "人物镜头存在多个角色参考包，需要人工选择");
		}
		const row = result.rows[0];
		const pack = {
			id: row.id,
			characterId: row.character_id,
			lookRevision: row.look_revision,
			status: row.status,
			frontAssetId: row.front_asset_id,
			sideAssetId: row.side_asset_id,
			backAssetId: row.back_asset_id,
			expressionAssetIds: asStringArray(row.expression_asset_ids, "角色表情表"),
		} satisfies CharacterReferencePack;
		validateReferencePack(pack);
		return pack;
	}
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((id) => expected.includes(id));
}

function isUniqueViolation(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
