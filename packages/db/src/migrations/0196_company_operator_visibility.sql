ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "operator_visible" boolean DEFAULT true NOT NULL;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "operator_company_id" uuid REFERENCES "companies"("id") ON DELETE SET NULL;
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "operator_company_id" uuid REFERENCES "companies"("id") ON DELETE SET NULL;

-- Keep future source-owned approvals visible to the holding without relying on
-- each approval producer to know about operator projection.
CREATE OR REPLACE FUNCTION inherit_approval_operator_company() RETURNS trigger AS $$
BEGIN
  SELECT CASE WHEN c.operator_visible = false THEN c.operator_company_id ELSE NULL END
    INTO NEW.operator_company_id
  FROM companies c
  WHERE c.id = NEW.company_id
  FOR SHARE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS approvals_inherit_operator_company ON approvals;
CREATE TRIGGER approvals_inherit_operator_company
BEFORE INSERT OR UPDATE OF company_id ON approvals
FOR EACH ROW EXECUTE FUNCTION inherit_approval_operator_company();
