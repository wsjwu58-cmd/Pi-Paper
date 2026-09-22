ALTER TABLE publications
    ADD COLUMN description TEXT,
    ADD COLUMN preview_asset_type VARCHAR(16),
    ADD COLUMN share_workflow BOOLEAN NOT NULL DEFAULT TRUE;
