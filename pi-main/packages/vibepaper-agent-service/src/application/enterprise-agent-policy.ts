export type EnterprisePolicyConfig = {
	tenantId: string;
	sharedPoolEnabled: boolean;
	memberQuotas: Readonly<Record<string, number>>;
};

export class EnterpriseAgentPolicy {
	private readonly consumed = new Map<string, number>();
	private readonly config: EnterprisePolicyConfig;

	constructor(config: EnterprisePolicyConfig) {
		this.config = config;
	}

	snapshotForRun(memberId: string): {
		tenantId: string;
		memberId: string;
		sharedPoolEnabled: boolean;
		quota: number | null;
	} {
		return {
			tenantId: this.config.tenantId,
			memberId,
			sharedPoolEnabled: this.config.sharedPoolEnabled,
			quota: this.config.memberQuotas[memberId] ?? null,
		};
	}

	assertMemoryWrite(input: { memberId: string; targetTenantId: string; admin: boolean }): void {
		if (input.targetTenantId !== this.config.tenantId) throw new Error("TENANT_ISOLATION");
		if (!input.admin) throw new Error("PERMISSION_DENIED");
	}

	authorizeProduction(input: { memberId: string; requestedPoints: number; enterpriseBalance: number }): void {
		if (!Number.isInteger(input.requestedPoints) || input.requestedPoints < 0) throw new Error("INVALID_INPUT");
		const quota = this.config.memberQuotas[input.memberId];
		const consumed = this.consumed.get(input.memberId) ?? 0;
		if (quota !== undefined && consumed + input.requestedPoints > quota) throw new Error("QUOTA_EXCEEDED");
		if (!this.config.sharedPoolEnabled && input.requestedPoints > input.enterpriseBalance)
			throw new Error("INSUFFICIENT_POINTS");
		this.consumed.set(input.memberId, consumed + input.requestedPoints);
	}
}
