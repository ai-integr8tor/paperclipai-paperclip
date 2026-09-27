import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  consolidateLegacyAgentSwarmBusiness: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  companyArtifactsService: () => ({
    list: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    ensureMembership: vi.fn(),
  }),
  budgetService: () => ({
    upsertPolicy: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    saveIssueVote: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

describe("company routes malformed issue path guard", () => {
  it("returns a clear error when companyId is missing for issues list path", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      };
      next();
    });
    app.use("/api/companies", companyRoutes({} as any));

    const res = await request(app).get("/api/companies/issues");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  it("routes only a marker-scoped consolidation request and returns Paperclip's active-run deferral", async () => {
    mockCompanyService.consolidateLegacyAgentSwarmBusiness.mockResolvedValue({
      state: "deferred_active_execution",
      sourceCompanyId: "00000000-0000-4000-8000-000000000001",
      targetCompanyId: "00000000-0000-4000-8000-000000000002",
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: "system",
      };
      next();
    });
    app.use("/api/companies", companyRoutes({} as any));

    const res = await request(app)
      .post("/api/companies/00000000-0000-4000-8000-000000000001/consolidate-legacy-agentswarm-business")
      .send({
        targetCompanyId: "00000000-0000-4000-8000-000000000002",
        businessId: "digital_services_products_worker_tool_publisher",
        holdingId: "digital_services_products",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "deferred_active_execution" });
    expect(mockCompanyService.consolidateLegacyAgentSwarmBusiness).toHaveBeenCalledWith(expect.objectContaining({
      sourceCompanyId: "00000000-0000-4000-8000-000000000001",
      targetCompanyId: "00000000-0000-4000-8000-000000000002",
      businessId: "digital_services_products_worker_tool_publisher",
      holdingId: "digital_services_products",
    }));
  });
});
