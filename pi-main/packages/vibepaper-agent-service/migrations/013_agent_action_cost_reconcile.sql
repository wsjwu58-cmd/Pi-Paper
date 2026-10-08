-- Legacy Agent databases created before approval costing need the column used by
-- PgApprovalRepository when a generation action is persisted.
ALTER TABLE agent_actions
    ADD COLUMN IF NOT EXISTS estimated_cost INTEGER NOT NULL DEFAULT 0;
