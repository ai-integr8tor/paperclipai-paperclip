ALTER TABLE "approvals" ADD COLUMN "brief" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "require_decision_brief" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "brief" jsonb;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN "brief" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "summary" text;