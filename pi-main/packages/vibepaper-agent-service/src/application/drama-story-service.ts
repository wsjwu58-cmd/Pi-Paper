import type { ContinuityFact, Episode, Foreshadow, Scene, StoryBible } from "../domain/drama-story.ts";
import { nextId } from "../infrastructure/ids.ts";

export type CreateBible = { ownerId: string; title: string; canon: string };
export type CreateEpisode = { ownerId: string; bibleId: string; number: number; title: string };
export type CreateScene = { ownerId: string; episodeId: string; number: number; summary: string };
export type CreateFact = { ownerId: string; sceneId: string; statement: string };
export type CreateForeshadow = { ownerId: string; sceneId: string; clue: string; payoff: string };

export interface DramaStoryRepository {
	bibles: Map<string, StoryBible>;
	episodes: Map<string, Episode>;
	scenes: Map<string, Scene>;
	facts: Map<string, ContinuityFact>;
	foreshadows: Map<string, Foreshadow>;
}

export class DramaStoryService {
	private readonly repository: DramaStoryRepository;

	constructor(repository: DramaStoryRepository) {
		this.repository = repository;
	}

	async createBible(input: CreateBible): Promise<StoryBible> {
		const bible = { id: nextId(), ...input, revision: 1, status: "draft" as const };
		this.repository.bibles.set(bible.id, bible);
		return bible;
	}

	async getBible(id: string, ownerId: string): Promise<StoryBible> {
		return this.require(this.repository.bibles.get(id), ownerId);
	}

	async reviseCanon(id: string, ownerId: string, canon: string): Promise<StoryBible> {
		const bible = await this.getBible(id, ownerId);
		const revised = { ...bible, canon: canon.trim(), revision: bible.revision + 1 };
		this.repository.bibles.set(id, revised);
		return revised;
	}

	async createEpisode(input: CreateEpisode): Promise<Episode> {
		this.require(this.repository.bibles.get(input.bibleId), input.ownerId);
		if (
			[...this.repository.episodes.values()].some(
				(item) => item.bibleId === input.bibleId && item.number === input.number && item.ownerId === input.ownerId,
			)
		)
			throw new Error("CONFLICT");
		const episode = { id: nextId(), ...input, status: "draft" as const };
		this.repository.episodes.set(episode.id, episode);
		return episode;
	}

	async createScene(input: CreateScene): Promise<Scene> {
		const episode = this.require(this.repository.episodes.get(input.episodeId), input.ownerId);
		if (
			[...this.repository.scenes.values()].some(
				(item) => item.episodeId === episode.id && item.number === input.number && item.ownerId === input.ownerId,
			)
		)
			throw new Error("CONFLICT");
		const scene = { id: nextId(), ...input, status: "draft" as const };
		this.repository.scenes.set(scene.id, scene);
		return scene;
	}

	async addContinuityFact(input: CreateFact): Promise<ContinuityFact> {
		this.require(this.repository.scenes.get(input.sceneId), input.ownerId);
		const fact = { id: nextId(), ...input };
		this.repository.facts.set(fact.id, fact);
		return fact;
	}

	async listContinuityFacts(sceneId: string, ownerId: string): Promise<readonly ContinuityFact[]> {
		this.require(this.repository.scenes.get(sceneId), ownerId);
		return [...this.repository.facts.values()].filter((fact) => fact.sceneId === sceneId && fact.ownerId === ownerId);
	}

	async plantForeshadow(input: CreateForeshadow): Promise<Foreshadow> {
		this.require(this.repository.scenes.get(input.sceneId), input.ownerId);
		const foreshadow = { id: nextId(), ...input, status: "planted" as const };
		this.repository.foreshadows.set(foreshadow.id, foreshadow);
		return foreshadow;
	}

	async resolveForeshadow(id: string, ownerId: string): Promise<Foreshadow> {
		const foreshadow = this.require(this.repository.foreshadows.get(id), ownerId);
		const resolved = { ...foreshadow, status: "resolved" as const };
		this.repository.foreshadows.set(id, resolved);
		return resolved;
	}

	private require<T extends { ownerId: string }>(value: T | undefined, ownerId: string): T {
		if (!value || value.ownerId !== ownerId) throw new Error("NOT_FOUND");
		return value;
	}
}

export class InMemoryDramaStoryRepository implements DramaStoryRepository {
	bibles = new Map<string, StoryBible>();
	episodes = new Map<string, Episode>();
	scenes = new Map<string, Scene>();
	facts = new Map<string, ContinuityFact>();
	foreshadows = new Map<string, Foreshadow>();
}
