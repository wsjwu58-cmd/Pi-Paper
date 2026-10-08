import type { CanvasCommandService } from "../application/canvas-command-service.ts";

export class CanvasCommandTools {
	private readonly service: CanvasCommandService;

	constructor(service: CanvasCommandService) {
		this.service = service;
	}

	createNodes(input: Parameters<CanvasCommandService["createNodes"]>[0]) {
		return this.service.createNodes(input);
	}
	connectNodes(input: Parameters<CanvasCommandService["connectNodes"]>[0]) {
		return this.service.connectNodes(input);
	}
	layoutNodes(input: Parameters<CanvasCommandService["layoutNodes"]>[0]) {
		return this.service.layoutNodes(input);
	}
	updateNodeConfig(input: Parameters<CanvasCommandService["updateNodeConfig"]>[0]) {
		return this.service.updateNodeConfig(input);
	}
	deleteNodes(input: Parameters<CanvasCommandService["deleteNodes"]>[0]) {
		return this.service.deleteNodes(input);
	}
}
