ALTER TABLE "deployments" ADD CONSTRAINT "deployments_rollback_of_id_deployments_id_fk" FOREIGN KEY ("rollback_of_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_parent_environment_id_environments_id_fk" FOREIGN KEY ("parent_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_organization_idx" ON "api_tokens" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "connections_to_instance_idx" ON "connections" USING btree ("to_instance_id");--> statement-breakpoint
CREATE INDEX "domains_instance_idx" ON "domains" USING btree ("service_instance_id");--> statement-breakpoint
CREATE INDEX "env_snapshots_instance_idx" ON "env_snapshots" USING btree ("service_instance_id");--> statement-breakpoint
CREATE INDEX "service_instances_environment_idx" ON "service_instances" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "variables_project_idx" ON "variables" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "variables_environment_idx" ON "variables" USING btree ("environment_id");