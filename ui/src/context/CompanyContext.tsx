import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Company } from "@paperclipai/shared";
import { companiesApi } from "../api/companies";
import { companiesListQueryOptions, type CompanyListResult } from "../api/companies-query";
import { queryKeys } from "../lib/queryKeys";
import type { CompanySelectionSource } from "../lib/company-selection";
import { isOperatorVisible } from "../lib/company-visibility";
type CompanySelectionOptions = { source?: CompanySelectionSource };

interface CompanyContextValue {
  companies: Company[];
  selectedCompanyId: string | null;
  selectedCompany: Company | null;
  selectionSource: CompanySelectionSource;
  loading: boolean;
  error: Error | null;
  setSelectedCompanyId: (companyId: string, options?: CompanySelectionOptions) => void;
  resolveHiddenCompanyHoldingByPrefix: (companyPrefix: string) => Company | null;
  reloadCompanies: () => Promise<void>;
  createCompany: (data: {
    name: string;
    description?: string | null;
    budgetMonthlyCents?: number;
  }) => Promise<Company>;
}

const STORAGE_KEY = "paperclip.selectedCompanyId";

const CompanyContext = createContext<CompanyContextValue | null>(null);

export function resolveBootstrapCompanySelection(input: {
  companies: Array<Pick<Company, "id"> & Partial<Pick<Company, "operatorCompanyId" | "operatorVisible">>>;
  sidebarCompanies: Array<Pick<Company, "id">>;
  selectedCompanyId: string | null;
  storedCompanyId: string | null;
}) {
  if (input.companies.length === 0) return null;

  const selectableCompanies = input.sidebarCompanies.length > 0
    ? input.sidebarCompanies
    : input.companies.filter(isOperatorVisible);
  const resolve = (id: string | null) => {
    if (!id) return null;
    if (selectableCompanies.some((company) => company.id === id)) return id;
    const holdingId = input.companies.find((company) => company.id === id)?.operatorCompanyId;
    return holdingId && selectableCompanies.some((company) => company.id === holdingId) ? holdingId : null;
  };
  const selected = resolve(input.selectedCompanyId);
  if (selected) return selected;
  const stored = resolve(input.storedCompanyId);
  if (stored) return stored;
  return selectableCompanies[0]?.id ?? null;
}

export function shouldClearStoredCompanySelection(input: {
  companies: Array<Pick<Company, "id">>;
  isLoading: boolean;
  unauthorized: boolean;
}) {
  return !input.isLoading && !input.unauthorized && input.companies.length === 0;
}

export function CompanyProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [selectionSource, setSelectionSource] = useState<CompanySelectionSource>("bootstrap");
  const [selectedCompanyId, setSelectedCompanyIdState] = useState<string | null>(null);

  const { data: companiesResult = { companies: [], unauthorized: false }, isLoading, error } =
    useQuery<CompanyListResult>(companiesListQueryOptions);
  const companies = useMemo(
    () => companiesResult.companies.filter(isOperatorVisible),
    [companiesResult.companies],
  );
  const companyListUnauthorized = companiesResult.unauthorized;
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );

  // Auto-select first company when list loads
  useEffect(() => {
    if (isLoading) return;
    if (companies.length === 0) {
      if (shouldClearStoredCompanySelection({ companies, isLoading: false, unauthorized: companyListUnauthorized })) {
        if (selectedCompanyId !== null) {
          setSelectedCompanyIdState(null);
        }
        localStorage.removeItem(STORAGE_KEY);
      }
      return;
    }

    const next = resolveBootstrapCompanySelection({
      companies: companiesResult.companies,
      sidebarCompanies,
      selectedCompanyId,
      storedCompanyId: localStorage.getItem(STORAGE_KEY),
    });
    if (next === null || next === selectedCompanyId) return;
    setSelectedCompanyIdState(next);
    setSelectionSource("bootstrap");
    localStorage.setItem(STORAGE_KEY, next);
  }, [companies, companiesResult.companies, companyListUnauthorized, isLoading, selectedCompanyId, sidebarCompanies]);

  const setSelectedCompanyId = useCallback((companyId: string, options?: CompanySelectionOptions) => {
    const requested = companiesResult.companies.find((company) => company.id === companyId);
    if (!requested) return;
    const resolvedCompanyId = isOperatorVisible(requested) ? companyId : requested.operatorCompanyId;
    if (!resolvedCompanyId || !companies.some((company) => company.id === resolvedCompanyId)) return;
    setSelectedCompanyIdState(resolvedCompanyId);
    setSelectionSource(options?.source ?? "manual");
    localStorage.setItem(STORAGE_KEY, resolvedCompanyId);
  }, [companies, companiesResult.companies]);

  const resolveHiddenCompanyHoldingByPrefix = useCallback((companyPrefix: string) => {
    const source = companiesResult.companies.find((company) =>
      company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase()
    );
    if (!source || isOperatorVisible(source) || !source.operatorCompanyId) return null;
    return companies.find((company) => company.id === source.operatorCompanyId) ?? null;
  }, [companies, companiesResult.companies]);

  const reloadCompanies = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description?: string | null;
      budgetMonthlyCents?: number;
    }) =>
      companiesApi.create(data),
    onSuccess: async (company) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      if (!isOperatorVisible(company)) return;
      setSelectedCompanyIdState(company.id);
      setSelectionSource("manual");
      localStorage.setItem(STORAGE_KEY, company.id);
    },
  });

  const createCompany = useCallback(
    async (data: {
      name: string;
      description?: string | null;
      budgetMonthlyCents?: number;
    }) => {
      return createMutation.mutateAsync(data);
    },
    [createMutation],
  );

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId],
  );

  const value = useMemo(
    () => ({
      companies,
      selectedCompanyId,
      selectedCompany,
      selectionSource,
      loading: isLoading,
      error: error as Error | null,
      setSelectedCompanyId,
      resolveHiddenCompanyHoldingByPrefix,
      reloadCompanies,
      createCompany,
    }),
    [
      companies,
      selectedCompanyId,
      selectedCompany,
      selectionSource,
      isLoading,
      error,
      setSelectedCompanyId,
      resolveHiddenCompanyHoldingByPrefix,
      reloadCompanies,
      createCompany,
    ],
  );

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) {
    throw new Error("useCompany must be used within CompanyProvider");
  }
  return ctx;
}

/**
 * Non-throwing variant of {@link useCompany}. Returns null when called outside a
 * CompanyProvider instead of throwing, so components that may render in
 * provider-less surfaces (e.g. exported/standalone markdown) can read company
 * state without crashing.
 */
export function useOptionalCompany(): CompanyContextValue | null {
  return useContext(CompanyContext);
}
