CREATE TABLE "github_webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_repo_links_installation_repo_idx" ON "github_repo_links" USING btree ("installation_id","repo_id");