CREATE TABLE "regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kube_context" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seed region: reference data, not user input (see db/src/schema.ts's DEFAULT_REGION_ID comment).
-- Inserted before projects.region_id is added below, so every existing project's new column
-- (defaulting to this id) satisfies the foreign key from the moment it's added. kube_context is
-- null: single-cluster deployments keep using the kubeconfig's own current-context, unchanged.
INSERT INTO "regions" ("id", "slug", "name") VALUES
	('00000000-0000-0000-0000-000000000001', 'default', 'Default');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "region_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "regions_slug_idx" ON "regions" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;