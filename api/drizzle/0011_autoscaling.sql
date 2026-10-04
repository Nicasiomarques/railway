ALTER TABLE "service_instances" ADD COLUMN "autoscaling_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service_instances" ADD COLUMN "min_replicas" integer;--> statement-breakpoint
ALTER TABLE "service_instances" ADD COLUMN "max_replicas" integer;--> statement-breakpoint
ALTER TABLE "service_instances" ADD COLUMN "target_cpu_percent" integer;--> statement-breakpoint
ALTER TABLE "service_instances" ADD COLUMN "cpu_request_millicores" integer;