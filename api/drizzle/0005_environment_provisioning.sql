CREATE TYPE "public"."environment_provisioning_status" AS ENUM('pending', 'provisioning', 'ready', 'failed');--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "provisioning_status" "environment_provisioning_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "provisioning_steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "provisioning_error" text;