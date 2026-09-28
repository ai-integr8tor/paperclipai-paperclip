CREATE TABLE "agent_instruction_heads" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"entry_file" text NOT NULL,
	"revision_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_instruction_heads_identity_uq" UNIQUE("company_id","agent_id","entry_file")
);
--> statement-breakpoint
CREATE TABLE "agent_instruction_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"entry_file" text NOT NULL,
	"content_base64" text NOT NULL,
	"content_hash" text NOT NULL,
	"byte_length" integer NOT NULL,
	"parent_revision_id" uuid,
	"base_revision_id" uuid,
	"restored_from_revision_id" uuid,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"responsible_user_id" text,
	"source_run_id" uuid,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_instruction_revisions_identity_uq" UNIQUE("company_id","agent_id","entry_file","id")
);
--> statement-breakpoint
ALTER TABLE "agent_instruction_heads" ADD CONSTRAINT "agent_instruction_heads_company_id_agent_id_entry_file_revision_id_agent_instruction_revisions_company_id_agent_id_entry_file_id_fk" FOREIGN KEY ("company_id","agent_id","entry_file","revision_id") REFERENCES "public"."agent_instruction_revisions"("company_id","agent_id","entry_file","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instruction_revisions" ADD CONSTRAINT "agent_instruction_revisions_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_instruction_revisions_history_idx" ON "agent_instruction_revisions" USING btree ("company_id","agent_id","entry_file","created_at","id");