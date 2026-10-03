ALTER TYPE "public"."service_source" ADD VALUE 'postgres_template';--> statement-breakpoint
ALTER TYPE "public"."service_source" ADD VALUE 'redis_template';--> statement-breakpoint
CREATE TABLE "volumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_instance_id" uuid NOT NULL,
	"mount_path" text NOT NULL,
	"size_gb" integer NOT NULL,
	"backup_state" text DEFAULT 'none' NOT NULL,
	"last_backup_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_service_instance_id_service_instances_id_fk" FOREIGN KEY ("service_instance_id") REFERENCES "public"."service_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "volumes_instance_idx" ON "volumes" USING btree ("service_instance_id");