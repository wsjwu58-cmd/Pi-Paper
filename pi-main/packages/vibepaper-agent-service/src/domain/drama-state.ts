export interface DramaFormatSpec {
	id: string;
	aspectRatio: "9:16";
	targetDurationSeconds: number;
	minShotCount: number;
	maxShotCount: number;
	minShotDurationSeconds: number;
	maxShotDurationSeconds: number;
	keyframeFirst: true;
}

export const STANDARD_VERTICAL_SHORT_DRAMA_FORMAT = {
	id: "vertical-short-drama-v1",
	aspectRatio: "9:16",
	targetDurationSeconds: 180,
	minShotCount: 60,
	maxShotCount: 90,
	minShotDurationSeconds: 2,
	maxShotDurationSeconds: 5,
	keyframeFirst: true,
} as const satisfies DramaFormatSpec;

export type ReferencePackStatus = "draft" | "approved" | "retired";
export type KeyframeStatus = "draft" | "accepted" | "rejected" | "stale";
export type RenderLineageStatus = "draft" | "ready_for_video" | "submitted" | "stale";

export class DramaDomainError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DramaDomainError";
		this.code = code;
	}
}

export interface DramaSeries {
	id: string;
	ownerId?: string;
	canvasId: string;
	activeCanonRevision: number;
	format: DramaFormatSpec;
}

export interface CharacterProfile {
	id: string;
	seriesId: string;
	name: string;
	identityAnchors: readonly string[];
	activeLookRevision: number;
	voiceId: string;
}

export interface CharacterReferencePack {
	id: string;
	characterId: string;
	lookRevision: number;
	status: ReferencePackStatus;
	frontAssetId: string;
	sideAssetId: string;
	backAssetId: string;
	expressionAssetIds: readonly string[];
}

export interface ShotCharacterBinding {
	characterId: string;
	lookRevision: number;
}

export interface ShotSpec {
	id: string;
	seriesId: string;
	episodeNo: number;
	shotNo: number;
	durationSeconds: number;
	characterBindings: readonly ShotCharacterBinding[];
	promptRevision: number;
}

export interface KeyframeRender {
	id: string;
	shotId: string;
	status: KeyframeStatus;
	referencePackIds: readonly string[];
}

export interface RenderLineage {
	id: string;
	shotId: string;
	keyframeRenderId: string;
	status: RenderLineageStatus;
}

export interface KeyframeNodeDraft {
	nodeType: "image";
	creativeType: "keyframe";
	shotId: string;
	referenceAssetIds: readonly string[];
	referencePackIds: readonly string[];
}

export interface VideoNodeDraft {
	nodeType: "video";
	creativeType: "clip";
	shotId: string;
	keyframeRenderId: string;
	referencePackIds: readonly string[];
}

export interface DramaStateStore {
	prepareKeyframeNode(shotId: string, ownerId?: string): KeyframeNodeDraft | Promise<KeyframeNodeDraft>;
	prepareVideoNode(shotId: string, ownerId?: string): VideoNodeDraft | Promise<VideoNodeDraft>;
}

function requireText(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new DramaDomainError("INVALID_INPUT", `${field}不能为空`);
	}
	return trimmed;
}

function assertIdentityAnchors(anchors: readonly string[]): void {
	const normalized = anchors.map((anchor) => requireText(anchor, "角色外形锚点"));
	if (normalized.length < 3 || normalized.length > 5) {
		throw new DramaDomainError("INVALID_IDENTITY_ANCHORS", "角色必须包含 3-5 条不可变外形锚点");
	}
	if (new Set(normalized).size !== normalized.length) {
		throw new DramaDomainError("INVALID_IDENTITY_ANCHORS", "角色外形锚点不能重复");
	}
}

function assertReferencePackComplete(pack: CharacterReferencePack): void {
	requireText(pack.frontAssetId, "角色正面参考图");
	requireText(pack.sideAssetId, "角色侧面参考图");
	requireText(pack.backAssetId, "角色背面参考图");
	if (pack.expressionAssetIds.length === 0) {
		throw new DramaDomainError("INCOMPLETE_REFERENCE_PACK", "角色参考包缺少表情表");
	}
}

export class InMemoryDramaStateStore implements DramaStateStore {
	private readonly seriesById = new Map<string, DramaSeries>();
	private readonly charactersById = new Map<string, CharacterProfile>();
	private readonly referencePacksByCharacterId = new Map<string, CharacterReferencePack[]>();
	private readonly shotsById = new Map<string, ShotSpec>();
	private readonly keyframesById = new Map<string, KeyframeRender>();
	private readonly lineagesById = new Map<string, RenderLineage>();

	createSeries(series: DramaSeries, ownerId?: string): void {
		if (this.seriesById.has(series.id)) {
			throw new DramaDomainError("CONFLICT", "短剧系列已存在");
		}
		if (series.format.aspectRatio !== "9:16") {
			throw new DramaDomainError("INVALID_FORMAT", "竖屏短剧必须使用 9:16");
		}
		this.seriesById.set(series.id, ownerId ? { ...series, ownerId } : series);
	}

	createCharacter(character: CharacterProfile, ownerId?: string): void {
		const series = this.seriesById.get(character.seriesId);
		if (!series || (ownerId && series.ownerId !== ownerId)) {
			throw new DramaDomainError("NOT_FOUND", "短剧系列不存在");
		}
		if (this.charactersById.has(character.id)) {
			throw new DramaDomainError("CONFLICT", "角色已存在");
		}
		requireText(character.name, "角色名");
		requireText(character.voiceId, "角色 voiceId");
		assertIdentityAnchors(character.identityAnchors);
		this.charactersById.set(character.id, character);
	}

	addReferencePack(pack: CharacterReferencePack, ownerId?: string): void {
		const character = this.charactersById.get(pack.characterId);
		const series = character ? this.seriesById.get(character.seriesId) : undefined;
		if (!character || (ownerId && series?.ownerId !== ownerId)) {
			throw new DramaDomainError("NOT_FOUND", "角色不存在");
		}
		if (pack.lookRevision !== character.activeLookRevision) {
			throw new DramaDomainError("VERSION_CONFLICT", "角色参考包不是当前 Look revision");
		}
		if (pack.status === "approved") {
			assertReferencePackComplete(pack);
		}
		const existing = this.referencePacksByCharacterId.get(pack.characterId) ?? [];
		if (existing.some((candidate) => candidate.id === pack.id)) {
			throw new DramaDomainError("CONFLICT", "角色参考包已存在");
		}
		this.referencePacksByCharacterId.set(pack.characterId, [...existing, pack]);
	}

	createShot(shot: ShotSpec, ownerId?: string): void {
		const series = this.seriesById.get(shot.seriesId);
		if (!series || (ownerId && series.ownerId !== ownerId)) {
			throw new DramaDomainError("NOT_FOUND", "短剧系列不存在");
		}
		if (this.shotsById.has(shot.id)) {
			throw new DramaDomainError("CONFLICT", "镜头已存在");
		}
		if (
			shot.durationSeconds < series.format.minShotDurationSeconds ||
			shot.durationSeconds > series.format.maxShotDurationSeconds
		) {
			throw new DramaDomainError("INVALID_SHOT_DURATION", "竖屏短剧单镜时长必须在 2-5 秒之间");
		}
		for (const binding of shot.characterBindings) {
			const character = this.charactersById.get(binding.characterId);
			if (!character || character.seriesId !== shot.seriesId) {
				throw new DramaDomainError("INVALID_CHARACTER_BINDING", "镜头包含无效角色");
			}
			if (binding.lookRevision !== character.activeLookRevision) {
				throw new DramaDomainError("VERSION_CONFLICT", "镜头未使用角色当前 Look revision");
			}
		}
		this.shotsById.set(shot.id, shot);
	}

	prepareKeyframeNode(shotId: string, ownerId?: string): KeyframeNodeDraft {
		const shot = this.requireShot(shotId, ownerId);
		const packs = shot.characterBindings.map((binding) => this.resolveSingleApprovedReferencePack(binding));
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

	recordKeyframe(render: KeyframeRender, ownerId?: string): void {
		const shot = this.requireShot(render.shotId, ownerId);
		if (render.status === "accepted") {
			const expectedPackIds = this.prepareKeyframeNode(shot.id, ownerId).referencePackIds;
			if (
				render.referencePackIds.length !== expectedPackIds.length ||
				render.referencePackIds.some((packId) => !expectedPackIds.includes(packId))
			) {
				throw new DramaDomainError("MISSING_CHARACTER_REFERENCE", "关键帧未绑定当前角色参考包");
			}
		}
		this.keyframesById.set(render.id, render);
	}

	prepareVideoNode(shotId: string, ownerId?: string): VideoNodeDraft {
		const shot = this.requireShot(shotId, ownerId);
		const keyframe = [...this.keyframesById.values()].find(
			(candidate) => candidate.shotId === shot.id && candidate.status === "accepted",
		);
		if (!keyframe) {
			throw new DramaDomainError("KEYFRAME_NOT_ACCEPTED", "视频生成必须引用已接受的关键帧");
		}
		const expectedPackIds = this.prepareKeyframeNode(shot.id).referencePackIds;
		if (
			keyframe.referencePackIds.length !== expectedPackIds.length ||
			keyframe.referencePackIds.some((packId) => !expectedPackIds.includes(packId))
		) {
			throw new DramaDomainError("MISSING_CHARACTER_REFERENCE", "视频生成缺少当前角色参考包");
		}
		return {
			nodeType: "video",
			creativeType: "clip",
			shotId: shot.id,
			keyframeRenderId: keyframe.id,
			referencePackIds: expectedPackIds,
		};
	}

	recordLineage(lineage: RenderLineage, ownerId?: string): void {
		this.requireShot(lineage.shotId, ownerId);
		if (!this.keyframesById.has(lineage.keyframeRenderId)) {
			throw new DramaDomainError("NOT_FOUND", "关键帧不存在");
		}
		this.lineagesById.set(lineage.id, lineage);
	}

	markLineagesStaleForCharacter(characterId: string, ownerId?: string): readonly string[] {
		const staleIds: string[] = [];
		for (const lineage of this.lineagesById.values()) {
			let shot: ShotSpec;
			try {
				shot = this.requireShot(lineage.shotId, ownerId);
			} catch (error) {
				if (ownerId && error instanceof DramaDomainError && error.code === "NOT_FOUND") continue;
				throw error;
			}
			if (!shot.characterBindings.some((binding) => binding.characterId === characterId)) continue;
			if (lineage.status !== "stale") {
				this.lineagesById.set(lineage.id, { ...lineage, status: "stale" });
				staleIds.push(lineage.id);
			}
		}
		return staleIds;
	}

	private requireShot(shotId: string, ownerId?: string): ShotSpec {
		const shot = this.shotsById.get(shotId);
		const series = shot ? this.seriesById.get(shot.seriesId) : undefined;
		if (!shot || (ownerId && series?.ownerId !== ownerId)) {
			throw new DramaDomainError("NOT_FOUND", "镜头不存在");
		}
		return shot;
	}

	private resolveSingleApprovedReferencePack(binding: ShotCharacterBinding): CharacterReferencePack {
		const packs = (this.referencePacksByCharacterId.get(binding.characterId) ?? []).filter(
			(pack) => pack.status === "approved" && pack.lookRevision === binding.lookRevision,
		);
		if (packs.length === 0) {
			throw new DramaDomainError("MISSING_CHARACTER_REFERENCE", "人物镜头缺少已批准角色参考包");
		}
		if (packs.length > 1) {
			throw new DramaDomainError("CHARACTER_REFERENCE_AMBIGUOUS", "人物镜头存在多个角色参考包，需要人工选择");
		}
		return packs[0];
	}
}
