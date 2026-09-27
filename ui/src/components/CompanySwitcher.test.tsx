// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySwitcher } from "./CompanySwitcher";

const mockUseCompany = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({ useCompany: mockUseCompany }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

describe("CompanySwitcher", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    mockUseCompany.mockReturnValue({
      companies: [
        { id: "holding", name: "Digital Services Products", status: "active", operatorVisible: true },
        { id: "runtime", name: "Worker Tool Publisher", status: "active", operatorVisible: false },
      ],
      selectedCompany: { id: "holding", name: "Digital Services Products", status: "active", operatorVisible: true },
      setSelectedCompanyId: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("does not list an active runtime-only company", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<CompanySwitcher open onOpenChange={() => {}} />);
    });

    expect(document.body.textContent).toContain("Digital Services Products");
    expect(document.body.textContent).not.toContain("Worker Tool Publisher");

    await act(async () => root.unmount());
  });
});
