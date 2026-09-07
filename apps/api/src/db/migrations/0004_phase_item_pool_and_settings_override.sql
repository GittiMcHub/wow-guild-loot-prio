ALTER TABLE "phases" ADD COLUMN "item_pool_mode" text DEFAULT 'PREDEFINED' NOT NULL;--> statement-breakpoint
ALTER TABLE "phases" ADD COLUMN "settings_override" jsonb;