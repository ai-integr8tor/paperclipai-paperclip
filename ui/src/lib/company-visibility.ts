/**
 * A company can remain active for native execution while deliberately hidden
 * from every operator-facing workspace surface. Missing is treated as visible
 * during a rolling server/UI deployment.
 */
export function isOperatorVisibleCompany(company: { operatorVisible?: boolean }) {
  return company.operatorVisible !== false;
}
