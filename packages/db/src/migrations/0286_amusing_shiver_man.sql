CREATE TABLE "agent_instruction_working_copies" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"responsible_user_id" text NOT NULL,
	"entry_file" text NOT NULL,
	"base_revision_id" uuid,
	"base_hash" text NOT NULL,
	"local_root" text NOT NULL,
	"execution_root" text NOT NULL,
	"location" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"candidate_base64" text,
	"candidate_hash" text,
	"error_code" text,
	"error_message" text,
	"receipt" jsonb,
	"process_stopped_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_instruction_working_copies" ADD CONSTRAINT "agent_instruction_working_copies_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instruction_working_copies" ADD CONSTRAINT "agent_instruction_working_copies_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_instruction_copies_pending_idx" ON "agent_instruction_working_copies" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "agent_instruction_copies_agent_idx" ON "agent_instruction_working_copies" USING btree ("company_id","agent_id","created_at");