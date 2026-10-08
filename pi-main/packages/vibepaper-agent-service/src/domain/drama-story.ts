export type StoryStatus = "draft" | "approved" | "archived";
export type ForeshadowStatus = "planted" | "resolved";

export type StoryBible = {
	id: string;
	ownerId: string;
	title: string;
	canon: string;
	revision: number;
	status: StoryStatus;
};
export type Episode = {
	id: string;
	ownerId: string;
	bibleId: string;
	number: number;
	title: string;
	status: StoryStatus;
};
export type Scene = {
	id: string;
	ownerId: string;
	episodeId: string;
	number: number;
	summary: string;
	status: StoryStatus;
};
export type ContinuityFact = { id: string; ownerId: string; sceneId: string; statement: string };
export type Foreshadow = {
	id: string;
	ownerId: string;
	sceneId: string;
	clue: string;
	payoff: string;
	status: ForeshadowStatus;
};
