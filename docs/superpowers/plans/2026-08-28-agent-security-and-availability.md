# Agent Security and Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Agent dialogue availability and enforce ownership, approval, and billing safety for the Node/Pi Agent service.

**Architecture:** Versioned PostgreSQL migrations establish durable ownership and approval data. Application services own approval state and execution, while the Tool Gateway remains the only cross-service side-effect boundary. Nacos registration is configured and observable so the Java gateway can resolve the Node service.

**Tech Stack:** Node.js 22.19+, TypeScript, Fastify, pg, Vitest, PostgreSQL, Nacos, Spring Cloud Gateway.

**Spec:** `docs/superpowers/specs/2026-08-28-agent-security-and-availability-design.md`

## Global Constraints

- Preserve the API prefix `/api/v1`, standardized error body, UTC timestamps, and integer point costs.
- Use only Tool Gateway calls for canvas, billing, generation, and other service effects.
- High-risk work requires a token bound to `user_id`, `canvas_id`, `canvas_version`, action hash, and expiry; changed canvas versions invalidate it.
- New global domain identifiers use Snowflake strings; do not add UUID domain IDs.
- Existing unowned drama records remain inaccessible to ordinary users.
- Production must fail closed when required internal authentication settings are absent.

---

### Task 1: Restore Nacos registration and gateway reachability

**Files:**
- Modify: `pi-main/packages/vibepaper-agent-service/src/config.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/nacos.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/server.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/.env.example`
- Modify: `agent-service/.env`
- Modify: `vibepaper-services/vibepaper-gateway/src/main/resources/application.yml`
- Test: `pi-main/packages/vibepaper-agent-service/test/config-and-nacos.test.ts`

**Interfaces:**
- Produces `validateStartupConfig(config): void` and `NacosRegistrar.start(): Promise<void>` that logs failed registration attempts.

- [ ] **Step 1: Write failing configuration and registrar tests**

```ts
it("uses the development Nacos credentials and the admin-service port", () => {
  const config = loadConfig({});
  expect(config.nacosUsername).toBe("nacos");
  expect(config.nacosPassword).toBe("nacos");
  expect(config.adminBaseUrl).toBe("http://localhost:8087");
});

it("rejects production startup without an internal token", () => {
  expect(() => validateStartupConfig(loadConfig({ VIBEPAPER_ENVIRONMENT: "production" }))).toThrow(
    "VIBEPAPER_INTERNAL_SERVICE_TOKEN",
  );
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service test -- config-and-nacos.test.ts`

Expected: FAIL because defaults and startup validation do not exist.

- [ ] **Step 3: Implement configuration validation and observable retries**

```ts
export function validateStartupConfig(config: ServiceConfig): void {
  if (config.environment === "production" && !config.internalServiceToken) {
    throw new Error("VIBEPAPER_INTERNAL_SERVICE_TOKEN is required in production");
  }
  if (config.environment === "production" && (!config.nacosUsername || !config.nacosPassword)) {
    throw new Error("Nacos credentials are required in production");
  }
}
```

Make `register`, `login`, and `beat` inspect `response.ok`, log status/error details through Fastify-compatible logging, and clear the token before retrying after authorization failure. Add gateway predicates for drama and render-review routes.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service test -- config-and-nacos.test.ts`

Expected: PASS.

### Task 2: Introduce versioned Agent migrations and safe IDs

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/migrations/001_baseline.sql`
- Create: `pi-main/packages/vibepaper-agent-service/migrations/002_agent_security.sql`
- Create: `pi-main/packages/vibepaper-agent-service/src/infrastructure/migrations.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/server.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/migrate.ts`
- Delete: `pi-main/packages/vibepaper-agent-service/src/infrastructure/schema.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/ids.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/migrations-and-ids.test.ts`

**Interfaces:**
- Produces `applyMigrations(database, migrationDirectory): Promise<void>` and collision-safe `nextId(now?: () => number): string`.

- [ ] **Step 1: Write failing migration and ID tests**

```ts
it("records each migration once in version order", async () => {
  await applyMigrations(database, fixturesDir);
  await applyMigrations(database, fixturesDir);
  expect(database.appliedVersions).toEqual(["001", "002"]);
});

it("does not reuse an ID when more than 4096 IDs are requested in one millisecond", () => {
  const ids = Array.from({ length: 4097 }, () => nextId(clock));
  expect(new Set(ids)).toHaveLength(4097);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service test -- migrations-and-ids.test.ts`

Expected: FAIL because no migration runner exists and IDs wrap at 4096.

- [ ] **Step 3: Implement ordered migrations and ID protections**

```sql
ALTER TABLE drama_series ADD COLUMN IF NOT EXISTS user_id BIGINT;
ALTER TABLE drama_series ADD COLUMN IF NOT EXISTS legacy_unowned BOOLEAN NOT NULL DEFAULT false;
UPDATE drama_series SET legacy_unowned = true WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS ix_drama_series_owner_canvas ON drama_series (user_id, canvas_id);
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS skill_id;
```

Execute SQL files within transactions, record filename and checksum in `schema_migrations`, and remove per-start dynamic schema DDL. Hold a monotonic timestamp and either wait for a new millisecond on sequence exhaustion or throw on backward time.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service test -- migrations-and-ids.test.ts`

Expected: PASS.

### Task 3: Enforce short-drama ownership and quarantine legacy data

**Files:**
- Modify: `pi-main/packages/vibepaper-agent-service/src/domain/drama-state.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/pg-drama-state-store.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/test/drama-state.test.ts`
- Create: `pi-main/packages/vibepaper-agent-service/test/drama-ownership.test.ts`

**Interfaces:**
- Produces owner-scoped store methods such as `prepareKeyframeNode(userId, shotId)` and `createSeries({ userId, ...series })`.

- [ ] **Step 1: Write failing owner-isolation tests**

```ts
it("returns not found when a different user requests a known shot", async () => {
  const response = await app.inject({ method: "POST", url: "/api/v1/drama/shots/900/keyframe-node", headers: { "x-user-id": "202" }, payload });
  expect(response.statusCode).toBe(404);
});

it("rejects a legacy series without user ownership", async () => {
  await expect(store.prepareKeyframeNode("101", "legacy-shot")).rejects.toMatchObject({ code: "NOT_FOUND" });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service test -- drama-ownership.test.ts`

Expected: FAIL because user identity is discarded by drama routes.

- [ ] **Step 3: Thread owner identity through the route and store**

```ts
private async requireSeries(userId: string, id: string): Promise<DramaSeries> {
  const result = await this.database.query<SeriesRow>(
    "SELECT id, user_id, canvas_id, active_canon_revision, format FROM drama_series WHERE id = $1 AND user_id = $2 AND legacy_unowned = false",
    [id, userId],
  );
  if (!result.rows[0]) throw new DramaDomainError("NOT_FOUND", "短剧系列不存在");
  return toSeries(result.rows[0]);
}
```

Use `nextId()` for every newly created drama entity and remove client-provided IDs from public create routes.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service test -- drama-ownership.test.ts drama-state.test.ts`

Expected: PASS.

### Task 4: Add approval creation, version invalidation, and billing-only execution

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/application/approval-service.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/tool-gateway.ts`
- Create: `pi-main/packages/vibepaper-agent-service/test/approval-service.test.ts`
- Create: `pi-main/packages/vibepaper-agent-service/test/tool-gateway.test.ts`

**Interfaces:**
- Produces `ApprovalService.plan(input): Promise<PlannedAction>` and `ApprovalService.consume(input, execute): Promise<ActionResult>`.

- [ ] **Step 1: Write failing approval and generation-path tests**

```ts
it("requires approval for a one-point generation", async () => {
  const action = await approvals.plan({ estimatedCost: 1, canvasVersion: 7, ...input });
  expect(action.requiresConfirmation).toBe(true);
  expect(action.approvalToken).toEqual(expect.any(String));
});

it("invalidates a confirmation when the canvas version changes", async () => {
  await expect(approvals.consume({ actionId: "1", token, currentCanvasVersion: 8 }, execute)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});

it("fails visibly when the queued canvas-node update fails", async () => {
  await expect(gateway.submitGeneration(...args)).rejects.toMatchObject({ code: "CANVAS_UPDATE_FAILED" });
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service test -- approval-service.test.ts tool-gateway.test.ts`

Expected: FAIL because actions are never persisted and node-update errors are swallowed.

- [ ] **Step 3: Implement deterministic action approval and execution**

```ts
const actionHash = createHash("sha256").update(canonicalJson(input.params)).digest("hex");
const tokenPayload = `${actionId}.${userId}.${canvasId}.${canvasVersion}.${actionHash}.${nonce}.${expiresAt.toISOString()}`;
const signature = createHmac("sha256", config.confirmSigningSecret).update(tokenPayload).digest("hex");
```

Persist action and approval in one transaction; consume through a conditional `UPDATE ... WHERE status = 'pending' ... RETURNING` before execution. Query current canvas version through the gateway, reject mismatches, and use a stable action ID as the billing `Idempotency-Key`. Update node state with an inspected response; log and throw on failure.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service test -- approval-service.test.ts tool-gateway.test.ts`

Expected: PASS.

### Task 5: Make SSE genuinely streaming and remove remaining drift

**Files:**
- Modify: `pi-main/packages/vibepaper-agent-service/src/application/agent-runtime.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Modify: `pi-paper-web/src/features/canvas/AgentPanel.tsx`
- Modify: `pi-main/packages/vibepaper-agent-service/package.json`
- Test: `pi-main/packages/vibepaper-agent-service/test/agent-streaming.test.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/api-contract.test.ts`

**Interfaces:**
- Produces `runDramaTurn(..., onEvent): Promise<CompletedTurn>` where `onEvent` receives each delta before completion.

- [ ] **Step 1: Write failing streaming and duplicate-Skill tests**

```ts
it("writes the first assistant delta before the turn finishes", async () => {
  const timestamps: number[] = [];
  await runDramaTurn(config, store, "1", [], "hello", skills, () => timestamps.push(Date.now()));
  expect(timestamps[0]).toBeLessThan(completedAt);
});

it("accepts duplicate skill IDs exactly once", async () => {
  const response = await app.inject({ method: "PUT", url: "/api/v1/agent/sessions/1/skills", headers, payload: { skillIds: ["9", "9"] } });
  expect(response.statusCode).toBe(200);
  expect(response.json().skillIds).toEqual(["9"]);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service test -- agent-streaming.test.ts api-contract.test.ts`

Expected: FAIL because all SSE data is buffered and duplicate IDs fail validation.

- [ ] **Step 3: Implement streamed deltas and low-risk cleanup**

```ts
reply.raw.write(`event: assistant_message\ndata: ${JSON.stringify({ type: "assistant_message", delta })}\n\n`);
```

Flush SSE headers before starting the turn; concatenate deltas for the persisted final message. Seed built-in skills once at server initialization, use `const HISTORY_LIMIT = 24`, deduplicate requested Skill IDs, and remove the unused Redis dependency/configuration. Remove the root Python Agent implementation after confirming the Node process remains the only `start-all.ps1` target.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service test -- agent-streaming.test.ts api-contract.test.ts`

Expected: PASS.

### Task 6: Final integration verification

**Files:**
- Modify: `docs/specs/V1.0-engineering-spec.md`

- [ ] **Step 1: Run the Agent package test suite**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service test`

Expected: PASS with no failed tests.

- [ ] **Step 2: Run the TypeScript build**

Run: `pnpm --dir pi-main/packages/vibepaper-agent-service build`

Expected: exit code 0.

- [ ] **Step 3: Verify Nacos and gateway paths after service restart**

Run: `Invoke-RestMethod http://localhost:8091/health; Invoke-RestMethod 'http://192.168.141.129:8848/nacos/v1/ns/instance/list?serviceName=agent-service&groupName=DEFAULT_GROUP&accessToken=<runtime-token>'`

Expected: health status `ok` and exactly one healthy Agent instance. Authenticate through the web app and send one Agent message through `/api/v1/agent/sessions/{id}/messages`; the gateway must not return 503.

- [ ] **Step 4: Update the engineering spec with the migration, ownership, approval, and discovery decisions**

Document `legacy_unowned` quarantine, owner-filtered drama reads/writes, confirmation-version invalidation, and required production configuration.
