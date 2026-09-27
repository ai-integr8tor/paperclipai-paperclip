ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "operator_visible" boolean NOT NULL DEFAULT true;
