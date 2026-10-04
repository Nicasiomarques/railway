ALTER TYPE "public"."deployment_trigger" ADD VALUE 'cron';--> statement-breakpoint
ALTER TABLE "service_instances" ADD COLUMN "schedule" text;