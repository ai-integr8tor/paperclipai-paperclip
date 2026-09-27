/** Runtime-only companies are present in the API for native execution, but
 * should never appear in an operator company surface. Missing values remain
 * visible while older API and UI versions overlap during deployment. */
export function isOperatorVisible(company: { operatorVisible?: boolean }): boolean {
  return company.operatorVisible !== false;
}
