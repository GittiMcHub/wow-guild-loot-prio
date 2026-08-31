ALTER TABLE phases ADD COLUMN item_pool_mode text NOT NULL DEFAULT 'PREDEFINED';
ALTER TABLE phases ADD COLUMN settings_override jsonb;
