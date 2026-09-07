ALTER TABLE "items" ADD COLUMN "acquired_via_item_id" integer;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "acquired_via_name" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "acquired_via_icon" text;