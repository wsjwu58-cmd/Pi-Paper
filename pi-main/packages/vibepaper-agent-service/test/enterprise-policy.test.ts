import { describe, expect, it } from "vitest";
import { EnterpriseAgentPolicy } from "../src/application/enterprise-agent-policy.ts";

describe("enterprise agent policy", () => {
	it("isolates tenant scope, keeps shared pool off and enforces member quota", () => {
		const policy = new EnterpriseAgentPolicy({
			tenantId: "ent-a",
			sharedPoolEnabled: false,
			memberQuotas: { "user-1": 3 },
		});
		expect(policy.snapshotForRun("user-1").tenantId).toBe("ent-a");
		expect(() => policy.assertMemoryWrite({ memberId: "user-1", targetTenantId: "ent-b", admin: true })).toThrow(
			"TENANT_ISOLATION",
		);
		expect(() =>
			policy.authorizeProduction({ memberId: "user-1", requestedPoints: 4, enterpriseBalance: 100 }),
		).toThrow("QUOTA_EXCEEDED");
		policy.authorizeProduction({ memberId: "user-1", requestedPoints: 3, enterpriseBalance: 100 });
		expect(() =>
			policy.authorizeProduction({ memberId: "user-1", requestedPoints: 1, enterpriseBalance: 100 }),
		).toThrow("QUOTA_EXCEEDED");
	});

	it("requires an administrator to publish enterprise memory", () => {
		const policy = new EnterpriseAgentPolicy({ tenantId: "ent-a", sharedPoolEnabled: false, memberQuotas: {} });
		expect(() => policy.assertMemoryWrite({ memberId: "user-1", targetTenantId: "ent-a", admin: false })).toThrow(
			"PERMISSION_DENIED",
		);
		policy.assertMemoryWrite({ memberId: "admin", targetTenantId: "ent-a", admin: true });
	});
});
