ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "operator_visible" boolean DEFAULT true NOT NULL;
