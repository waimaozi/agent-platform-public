import { describe, expect, it } from "vitest";
import { PrismaSecretsService, SecretAccessLevel, __private__ } from "@agent-platform/secrets-service";

describe("PrismaSecretsService", () => {
  it("encrypts and decrypts values roundtrip", () => {
    const key = __private__.resolveEncryptionKey("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const encrypted = __private__.encryptValue("top-secret", key);

    expect(encrypted).not.toContain("top-secret");
    expect(__private__.decryptValue(encrypted, key)).toBe("top-secret");
  });

  it("stores and returns a value for an allowed actor", async () => {
    const db = createSecretsDb();
    const service = new PrismaSecretsService({
      db,
      encryptionKeyHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    await service.store({
      serviceName: "github",
      key: "TOKEN",
      value: "ghp_123",
      scope: "global",
      allowedActors: ["coder_inject"]
    });

    const [reference] = await service.getReference("github", "TOKEN");
    expect(reference?.serviceName).toBe("github");
    expect(await service.getValue(reference.id, "coder_inject")).toBe("ghp_123");
  });

  it("returns null for an actor without access", async () => {
    const db = createSecretsDb();
    const service = new PrismaSecretsService({
      db,
      encryptionKeyHex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });

    await service.store({
      serviceName: "n8n",
      key: "API_KEY",
      value: "n8n-secret",
      scope: "global",
      allowedActors: ["executor_inject"]
    });

    const [reference] = await service.getReference("n8n", "API_KEY");
    expect(await service.getValue(reference.id, "coder_inject")).toBeNull();
  });

  it("returns references without exposing values", async () => {
    const db = createSecretsDb();
    const service = new PrismaSecretsService({
      db,
      encryptionKeyHex: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    });

    await service.store({
      serviceName: "anthropic",
      key: "API_KEY",
      value: "sk-ant-123",
      scope: "global",
      allowedActors: ["supervisor_ref"],
      description: "Primary Anthropic key"
    });

    const [reference] = await service.getReference("anthropic");
    expect(reference).toEqual({
      id: expect.any(String),
      serviceName: "anthropic",
      key: "API_KEY",
      description: "Primary Anthropic key",
      scope: "global",
      allowedActors: ["supervisor_ref"]
    });
    expect(Object.values(reference)).not.toContain("sk-ant-123");
  });

  it("returns decrypted env bundles for runtime injection", async () => {
    const db = createSecretsDb();
    const service = new PrismaSecretsService({
      db,
      encryptionKeyHex: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    });

    await service.store({
      serviceName: "github",
      key: "TOKEN",
      value: "global-token",
      scope: "global",
      allowedActors: ["coder_inject"]
    });

    await service.store({
      serviceName: "github",
      key: "TOKEN",
      value: "project-token",
      scope: "project",
      projectId: "project-1",
      allowedActors: ["coder_inject"]
    });

    await service.store({
      serviceName: "github",
      key: "PAT_TOKEN",
      value: "pat-token",
      scope: "project",
      projectId: "project-1",
      allowedActors: ["coder_inject", "executor_inject"]
    });

    expect(await service.getEnvBundle("github", "coder_inject", "project-1")).toEqual({
      GITHUB_PAT_TOKEN: "pat-token",
      GITHUB_TOKEN: "project-token"
    });
  });
});

function createSecretsDb() {
  const secrets: Array<{
    id: string;
    serviceName: string;
    key: string;
    encryptedValue: string;
    scope: "global" | "project" | "user";
    projectId: string | null;
    userId: string | null;
    allowedActors: SecretAccessLevel[];
    description: string | null;
    rotatedAt: Date | null;
  }> = [];

  return {
    serviceSecret: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        secrets.find((secret) => matchesWhere(secret, where)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        secrets.find((secret) => secret.id === where.id) ?? null,
      findMany: async ({
        where
      }: {
        where?: Record<string, unknown>;
        orderBy?: Array<Record<string, "asc" | "desc">>;
      } = {}) => secrets.filter((secret) => matchesWhere(secret, where ?? {})),
      create: async ({
        data
      }: {
        data: {
          serviceName: string;
          key: string;
          encryptedValue: string;
          scope: "global" | "project" | "user";
          projectId?: string | null;
          userId?: string | null;
          allowedActors: SecretAccessLevel[];
          description?: string | null;
          rotatedAt?: Date | null;
        };
      }) => {
        const record = {
          id: `secret-${secrets.length + 1}`,
          serviceName: data.serviceName,
          key: data.key,
          encryptedValue: data.encryptedValue,
          scope: data.scope,
          projectId: data.projectId ?? null,
          userId: data.userId ?? null,
          allowedActors: data.allowedActors,
          description: data.description ?? null,
          rotatedAt: data.rotatedAt ?? null
        };
        secrets.push(record);
        return record;
      },
      update: async ({
        where,
        data
      }: {
        where: { id: string };
        data: Partial<{
          encryptedValue: string;
          allowedActors: SecretAccessLevel[];
          description: string | null;
          rotatedAt: Date | null;
        }>;
      }) => {
        const record = secrets.find((secret) => secret.id === where.id);
        if (!record) {
          throw new Error(`Unknown secret ${where.id}`);
        }

        Object.assign(record, data);
        return record;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const index = secrets.findIndex((secret) => secret.id === where.id);
        if (index === -1) {
          throw new Error(`Unknown secret ${where.id}`);
        }

        const [removed] = secrets.splice(index, 1);
        return removed;
      }
    }
  };
}

function matchesWhere(
  secret: Record<string, unknown>,
  where: Record<string, unknown>
) {
  return Object.entries(where).every(([key, value]) => secret[key] === value);
}
