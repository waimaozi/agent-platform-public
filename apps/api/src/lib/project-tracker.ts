import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@agent-platform/core";

type ProjectStatus = "active" | "on_hold" | "completed" | "cancelled" | "planning";
type Priority = "low" | "normal" | "high" | "urgent";

export interface ProjectSummary {
  id: string;
  name: string;
  status: ProjectStatus;
  deadline: Date | null;
  priority: Priority;
  lastActivityAt: Date | null;
}

export interface ProjectDetails extends ProjectSummary {
  blockers: string[];
  notes: string | null;
  repoUrl: string | null;
}

export class ProjectTrackerService {
  constructor(private readonly db: PrismaClient = prisma) {}

  async listProjects(): Promise<ProjectSummary[]> {
    return (this.db.projectProfile as any).findMany({
      orderBy: [{ status: "asc" }, { deadline: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        status: true,
        deadline: true,
        priority: true,
        lastActivityAt: true
      }
    });
  }

  async getProject(nameOrId: string): Promise<ProjectDetails | null> {
    return (this.db.projectProfile as any).findFirst({
      where: buildProjectLookup(nameOrId),
      select: {
        id: true,
        name: true,
        status: true,
        deadline: true,
        priority: true,
        lastActivityAt: true,
        blockers: true,
        notes: true,
        repoUrl: true
      }
    });
  }

  async addProject(name: string) {
    const cleanName = name.trim();
    if (!cleanName) {
      throw new Error("Project name is required");
    }

    const existing = await (this.db.projectProfile as any).findFirst({
      where: {
        name: { equals: cleanName, mode: "insensitive" }
      }
    });
    if (existing) {
      return existing;
    }

    return (this.db.projectProfile as any).create({
      data: {
        name: cleanName,
        status: "planning",
        priority: "normal",
        blockers: []
      }
    });
  }

  async updateProject(nameOrId: string, field: string, rawValue: string) {
    const project = await (this.db.projectProfile as any).findFirst({
      where: buildProjectLookup(nameOrId),
      select: { id: true, name: true }
    });
    if (!project) {
      throw new Error(`Project ${nameOrId} not found.`);
    }

    const data = parseProjectUpdate(field, rawValue);
    return (this.db.projectProfile as any).update({
      where: { id: project.id },
      data
    });
  }

  async setDeadline(nameOrId: string, rawDate: string) {
    const parsed = parseDate(rawDate);
    if (!parsed) {
      throw new Error("Deadline must be an ISO date like 2026-04-10.");
    }

    return this.updateProject(nameOrId, "deadline", rawDate);
  }

  async touchProject(projectId: string, at = new Date()) {
    return (this.db.projectProfile as any).update({
      where: { id: projectId },
      data: { lastActivityAt: at }
    });
  }
}

export interface SeededProject {
  name: string;
  status: ProjectStatus;
  notes: string | null;
  repoUrl: string | null;
  deadline: Date | null;
  blockers: string[];
}

export async function seedProjectsFromMarkdown(
  db: Pick<PrismaClient, "projectProfile"> = prisma,
  markdownPath = resolve(process.cwd(), "docs/PROJECTS.md")
) {
  const markdown = await readFile(markdownPath, "utf8");
  const projects = parseProjectsMarkdown(markdown);

  for (const project of projects) {
    const existing = await (db.projectProfile as any).findFirst({
      where: {
        name: { equals: project.name, mode: "insensitive" }
      }
    });

    if (existing) {
      await (db.projectProfile as any).update({
        where: { id: existing.id },
        data: {
          status: project.status,
          notes: project.notes,
          repoUrl: project.repoUrl,
          deadline: project.deadline,
          blockers: project.blockers
        }
      });
      continue;
    }

    await (db.projectProfile as any).create({
      data: {
        name: project.name,
        status: project.status,
        notes: project.notes,
        repoUrl: project.repoUrl,
        deadline: project.deadline,
        blockers: project.blockers,
        priority: "normal"
      }
    });
  }

  return projects;
}

export function parseProjectsMarkdown(markdown: string): SeededProject[] {
  const sections = markdown.split(/^##\s+\d+\.\s+/m).slice(1);
  return sections.map((section) => {
    const lines = section.trim().split("\n");
    const name = lines[0]?.trim() ?? "Untitled";
    const statusLine = lines.find((line) => line.startsWith("**Status:**")) ?? "";
    const repoLine = lines.find((line) => line.startsWith("**Repo:**")) ?? "";
    const descriptionLine = lines.find((line) => line.startsWith("**Description:**")) ?? "";
    const nextStepsLine = lines.find((line) => line.startsWith("**Next steps:**")) ?? "";

    return {
      name,
      status: normalizeProjectStatus(statusLine.replace("**Status:**", "").trim()),
      repoUrl: repoLine ? repoLine.replace("**Repo:**", "").trim() : null,
      notes: [descriptionLine, nextStepsLine]
        .map((value) => value.replace(/^\*\*(Description|Next steps):\*\*/, "").trim())
        .filter(Boolean)
        .join("\n\n") || null,
      deadline: extractDeadline(section),
      blockers: extractBlockers(section)
    };
  });
}

export function parseProjectUpdate(field: string, rawValue: string) {
  const normalizedField = field.trim().toLowerCase();
  const value = rawValue.trim();

  if (normalizedField === "status") {
    return { status: normalizeProjectStatus(value) };
  }
  if (normalizedField === "deadline") {
    const parsed = parseDate(value);
    if (!parsed) {
      throw new Error("Deadline must be an ISO date like 2026-04-10.");
    }
    return { deadline: parsed };
  }
  if (normalizedField === "priority") {
    return { priority: normalizePriority(value) };
  }
  if (normalizedField === "blockers") {
    return {
      blockers: value
        ? value.split(/[;,|]/).map((item) => item.trim()).filter(Boolean)
        : []
    };
  }
  if (normalizedField === "notes") {
    return { notes: value || null };
  }

  throw new Error("Supported fields: status, deadline, priority, blockers, notes");
}

export function formatProjectList(projects: ProjectSummary[]): string {
  if (projects.length === 0) {
    return "No projects found.";
  }

  return [
    "Projects:",
    ...projects.map((project) => {
      const deadline = project.deadline ? ` | deadline ${formatDate(project.deadline)}` : "";
      return `- ${project.name} [${project.status}]${deadline}`;
    })
  ].join("\n");
}

export function formatProjectDetails(project: ProjectDetails): string {
  return [
    `${project.name}`,
    `Status: ${project.status}`,
    `Priority: ${project.priority}`,
    `Deadline: ${project.deadline ? formatDate(project.deadline) : "none"}`,
    `Last activity: ${project.lastActivityAt ? project.lastActivityAt.toISOString() : "unknown"}`,
    `Repo: ${project.repoUrl ?? "n/a"}`,
    `Blockers: ${project.blockers.length > 0 ? project.blockers.join("; ") : "none"}`,
    `Notes: ${project.notes ?? "none"}`
  ].join("\n");
}

function buildProjectLookup(nameOrId: string) {
  return {
    OR: [
      { id: nameOrId },
      { name: { equals: nameOrId, mode: "insensitive" as const } },
      { name: { contains: nameOrId, mode: "insensitive" as const } }
    ]
  };
}

function normalizeProjectStatus(value: string): ProjectStatus {
  const normalized = value.trim().toLowerCase();
  if (/(on hold|hold|waiting)/.test(normalized)) {
    return "on_hold";
  }
  if (/(completed|done|shipped|preserved)/.test(normalized)) {
    return "completed";
  }
  if (/(cancelled|canceled|dead|unprofitable)/.test(normalized)) {
    return "cancelled";
  }
  if (/(plan|planning|almost ready)/.test(normalized)) {
    return "planning";
  }
  return "active";
}

function normalizePriority(value: string): Priority {
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "normal" || normalized === "high" || normalized === "urgent") {
    return normalized;
  }
  throw new Error("Priority must be one of: low, normal, high, urgent");
}

function parseDate(value: string): Date | null {
  const parsed = new Date(`${value.trim()}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractDeadline(section: string): Date | null {
  const match = section.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return match ? parseDate(match[1]) : null;
}

function extractBlockers(section: string): string[] {
  const blockers: string[] = [];
  const waitingMatch = section.match(/waiting for ([^\n.]+)/i);
  if (waitingMatch?.[1]) {
    blockers.push(`Waiting for ${waitingMatch[1].trim()}`);
  }
  return blockers;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
