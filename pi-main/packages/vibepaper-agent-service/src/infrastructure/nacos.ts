import type { ServiceConfig } from "../config.ts";

export class NacosRegistrar {
	private accessToken?: string;
	private heartbeat?: NodeJS.Timeout;
	private readonly ip: string;
	private readonly config: ServiceConfig;
	private readonly port: number;

	constructor(config: ServiceConfig, port: number) {
		this.config = config;
		this.port = port;
		this.ip = config.nacosRegisterIp || "127.0.0.1";
	}

	async start(): Promise<void> {
		if (!this.config.nacosUsername || !this.config.nacosPassword) {
			if (this.config.environment === "production" || this.config.environment === "staging")
				throw new Error("NACOS_CREDENTIALS_MISSING");
			return;
		}
		await this.register();
		this.heartbeat = setInterval(() => {
			void this.beat();
		}, 5000);
		this.heartbeat.unref();
	}

	async stop(): Promise<void> {
		if (this.heartbeat) clearInterval(this.heartbeat);
		if (!this.accessToken) return;
		const query = new URLSearchParams({
			serviceName: this.config.appName,
			ip: this.ip,
			port: String(this.port),
			groupName: "DEFAULT_GROUP",
			ephemeral: "true",
			accessToken: this.accessToken,
		});
		await fetch(`http://${this.config.nacosAddr}/nacos/v1/ns/instance?${query}`, {
			method: "DELETE",
			signal: AbortSignal.timeout(5000),
		}).catch(() => undefined);
	}

	private async register(): Promise<void> {
		const token = await this.login();
		if (!token) throw new Error("NACOS_LOGIN_FAILED");
		const query = new URLSearchParams({
			serviceName: this.config.appName,
			ip: this.ip,
			port: String(this.port),
			groupName: "DEFAULT_GROUP",
			clusterName: "DEFAULT",
			ephemeral: "true",
			weight: "1",
			enabled: "true",
			healthy: "true",
			metadata: JSON.stringify({ app: this.config.appName, runtime: "pi-agent" }),
			accessToken: token,
		});
		const response = await fetch(`http://${this.config.nacosAddr}/nacos/v1/ns/instance?${query}`, {
			method: "POST",
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw new Error(`NACOS_REGISTER_FAILED:${response.status}`);
	}

	private async beat(): Promise<void> {
		if (!this.accessToken) {
			await this.register();
			return;
		}
		const beat = JSON.stringify({
			cluster: "DEFAULT",
			ip: this.ip,
			port: this.port,
			serviceName: this.config.appName,
			scheduled: true,
			weight: 1,
			metadata: { app: this.config.appName, runtime: "pi-agent" },
		});
		const query = new URLSearchParams({
			serviceName: this.config.appName,
			groupName: "DEFAULT_GROUP",
			ephemeral: "true",
			beat,
			accessToken: this.accessToken,
		});
		const response = await fetch(`http://${this.config.nacosAddr}/nacos/v1/ns/instance/beat?${query}`, {
			method: "PUT",
			signal: AbortSignal.timeout(5000),
		}).catch(() => undefined);
		if (!response || response.status === 401 || response.status === 403) {
			this.accessToken = undefined;
		}
	}

	private async login(): Promise<string | undefined> {
		const body = new URLSearchParams({ username: this.config.nacosUsername, password: this.config.nacosPassword });
		const response = await fetch(`http://${this.config.nacosAddr}/nacos/v1/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal: AbortSignal.timeout(5000),
		}).catch(() => undefined);
		if (!response?.ok) return undefined;
		const data = await response.json();
		if (typeof data === "object" && data !== null && "accessToken" in data && typeof data.accessToken === "string") {
			this.accessToken = data.accessToken;
			return data.accessToken;
		}
		return undefined;
	}
}
