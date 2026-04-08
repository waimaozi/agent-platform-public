import { describe, expect, it } from "vitest";
import { findN8nWorkflow, getActiveN8nWorkflows, N8N_WORKFLOWS } from "@agent-platform/integrations";

describe("n8n registry", () => {
  it("lists the expected registered workflows", () => {
    expect(N8N_WORKFLOWS).toHaveLength(7);
    expect(N8N_WORKFLOWS.map((workflow) => workflow.id)).toEqual([
      "zmJ2QkMZiAYrqiXz",
      "NRp0UCIFeA6QxgBk",
      "wfRfybltF8BNjyji",
      "oF9VaOBm4ZB0AJxf",
      "F0WuLGxmvJPiMlPr",
      "LCBVl1ENxowASIAW",
      "QGQ7yreibLk6JrgW"
    ]);
    expect(getActiveN8nWorkflows().map((workflow) => workflow.name)).toEqual([
      "Chemitech Mail Agent",
      "Mira CRM Lead Capture",
      "Chemitech SGR Bot",
      "ByPlan Lead Form"
    ]);
  });

  it("resolves workflows by slug, webhook path, and id", () => {
    expect(findN8nWorkflow("chemitech-sgr")?.webhookPath).toBe("chemitech-test");
    expect(findN8nWorkflow("imap-agent")?.name).toBe("Chemitech Mail Agent");
    expect(findN8nWorkflow("QGQ7yreibLk6JrgW")?.name).toBe("ByPlan Lead Form");
  });
});
