import { describe, expect, it } from "vitest";
import {
  formatProjectDetails,
  formatProjectList,
  parseProjectsMarkdown,
  ProjectTrackerService
} from "../apps/api/src/lib/project-tracker.js";

describe("project tracker", () => {
  it("supports project CRUD operations", async () => {
    const db = createProjectDb();
    const service = new ProjectTrackerService(db as never);

    await service.addProject("Alpha");
    await service.updateProject("Alpha", "status", "on_hold");
    await service.updateProject("Alpha", "deadline", "2026-04-10");
    await service.updateProject("Alpha", "priority", "high");
    await service.updateProject("Alpha", "blockers", "Waiting for API; missing design");
    await service.updateProject("Alpha", "notes", "Important project");

    const project = await service.getProject("Alpha");
    const list = await service.listProjects();

    expect(project?.status).toBe("on_hold");
    expect(project?.priority).toBe("high");
    expect(project?.blockers).toEqual(["Waiting for API", "missing design"]);
    expect(project?.deadline?.toISOString()).toContain("2026-04-10");
    expect(formatProjectList(list)).toContain("Alpha [on_hold]");
    expect(project ? formatProjectDetails(project) : "").toContain("Important project");
  });

  it("parses docs/PROJECTS.md sections into seeded projects", () => {
    const markdown = [
      "## 1. Agent Platform",
      "**Status:** Active development",
      "**Repo:** github.com/example/agent-platform",
      "**Description:** Main platform",
      "**Next steps:** Ship it",
      "",
      "## 2. ByPlan",
      "**Status:** On hold - waiting for partner",
      "**Description:** Apartment planning"
    ].join("\n");

    const projects = parseProjectsMarkdown(markdown);

    expect(projects).toHaveLength(2);
    expect(projects[0]).toEqual(
      expect.objectContaining({
        name: "Agent Platform",
        status: "active",
        repoUrl: "github.com/example/agent-platform"
      })
    );
    expect(projects[1]?.status).toBe("on_hold");
  });
});

function createProjectDb() {
  const projects: Array<Record<string, any>> = [];

  return {
    projectProfile: {
      findMany: async () => [...projects],
      findFirst: async ({ where }: { where: Record<string, any> }) => {
        return projects.find((project) => matchesProject(project, where)) ?? null;
      },
      create: async ({ data }: { data: Record<string, any> }) => {
        const project = {
          id: `project-${projects.length + 1}`,
          deadline: null,
          priority: "normal",
          blockers: [],
          lastActivityAt: null,
          notes: null,
          repoUrl: null,
          ...data
        };
        projects.push(project);
        return project;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const project = projects.find((item) => item.id === where.id);
        if (!project) {
          throw new Error("project missing");
        }
        Object.assign(project, data);
        return project;
      }
    }
  };
}

function matchesProject(project: Record<string, any>, where: Record<string, any>) {
  const clauses = Array.isArray(where.OR) ? where.OR : [where];
  return clauses.some((clause) =>
    Object.entries(clause).every(([key, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if ("equals" in value) {
          return String(project[key]).toLowerCase() === String(value.equals).toLowerCase();
        }
        if ("contains" in value) {
          return String(project[key]).toLowerCase().includes(String(value.contains).toLowerCase());
        }
      }
      return project[key] === value;
    })
  );
}
