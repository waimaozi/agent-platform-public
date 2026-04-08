export interface N8nWorkflow {
  id: string;
  name: string;
  webhookPath: string;
  active: boolean;
  description: string;
  inputSchema?: Record<string, string>;
}

export const N8N_WORKFLOWS: N8nWorkflow[] = [
  {
    id: "zmJ2QkMZiAYrqiXz",
    name: "Chemitech Mail Agent",
    webhookPath: "imap-agent",
    active: true,
    description: "Send emails from Chemitech addresses (service@, info@, letters@, education@)"
  },
  {
    id: "NRp0UCIFeA6QxgBk",
    name: "Mira CRM Lead Capture",
    webhookPath: "mira-crm-lead",
    active: true,
    description: "Capture and store CRM leads"
  },
  {
    id: "wfRfybltF8BNjyji",
    name: "Chemitech SGR Bot",
    webhookPath: "chemitech-test",
    active: true,
    description: "Answer questions about Chemitech professional chemistry products"
  },
  {
    id: "oF9VaOBm4ZB0AJxf",
    name: "Calendar Agent",
    webhookPath: "calendar-agent",
    active: false,
    description: "Create and query Google Calendar events (needs webhook trigger added in n8n)"
  },
  {
    id: "F0WuLGxmvJPiMlPr",
    name: "Yandex STT",
    webhookPath: "yandex-stt",
    active: false,
    description: "Transcribe voice messages via Yandex Speech-to-Text"
  },
  {
    id: "LCBVl1ENxowASIAW",
    name: "Deep Research",
    webhookPath: "deep-research",
    active: false,
    description: "Deep research on a topic using LLM agents"
  },
  {
    id: "QGQ7yreibLk6JrgW",
    name: "ByPlan Lead Form",
    webhookPath: "byplan-lead",
    active: true,
    description: "Process ByPlan website lead submissions"
  }
];

export function getActiveN8nWorkflows(): N8nWorkflow[] {
  return N8N_WORKFLOWS.filter((workflow) => workflow.active);
}

export function findN8nWorkflow(identifier: string): N8nWorkflow | undefined {
  const normalizedIdentifier = normalizeWorkflowKey(identifier);

  return N8N_WORKFLOWS.find((workflow) => {
    const candidates = new Set<string>([
      workflow.id,
      workflow.webhookPath,
      workflow.name,
      normalizeWorkflowKey(workflow.name),
      stripWorkflowSuffix(normalizeWorkflowKey(workflow.name))
    ]);

    return Array.from(candidates).some((candidate) => normalizeWorkflowKey(candidate) === normalizedIdentifier);
  });
}

export function formatN8nWorkflowStatus(workflow: N8nWorkflow): string {
  return `${workflow.active ? "active" : "inactive"}`;
}

export function getN8nWorkflowBundleDescription(workflow: N8nWorkflow): string {
  switch (workflow.id) {
    case "zmJ2QkMZiAYrqiXz":
      return "send emails from Chemitech addresses";
    case "NRp0UCIFeA6QxgBk":
      return "capture leads";
    case "wfRfybltF8BNjyji":
      return "answer chemistry product questions";
    case "QGQ7yreibLk6JrgW":
      return "process ByPlan leads";
    default:
      return workflow.description;
  }
}

function normalizeWorkflowKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function stripWorkflowSuffix(value: string): string {
  return value.replace(/-(agent|bot|workflow)$/, "");
}
