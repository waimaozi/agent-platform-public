import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@agent-platform/core";

export type SecretScope = "global" | "project" | "user";
export type SecretAccessLevel = "supervisor_ref" | "coder_inject" | "executor_inject" | "direct_read";

export interface StoreSecretInput {
  serviceName: string;
  key: string;
  value: string;
  scope: SecretScope;
  projectId?: string;
  userId?: string;
  allowedActors: SecretAccessLevel[];
  description?: string;
}

export interface SecretReference {
  id: string;
  serviceName: string;
  key: string;
  description: string | null;
  scope: string;
  allowedActors: SecretAccessLevel[];
}

export interface ServiceInfo {
  serviceName: string;
  keyCount: number;
  scope: string;
}

export interface SecretsService {
  store(input: StoreSecretInput): Promise<void>;
  getReference(serviceName: string, key?: string): Promise<SecretReference[]>;
  getValue(secretId: string, actor: SecretAccessLevel): Promise<string | null>;
  getEnvBundle(serviceName: string, actor: SecretAccessLevel, projectId?: string): Promise<Record<string, string>>;
  listServices(): Promise<ServiceInfo[]>;
  rotate(secretId: string, newValue: string): Promise<void>;
  delete(secretId: string): Promise<void>;
}

interface ServiceSecretRecord {
  id: string;
  serviceName: string;
  key: string;
  encryptedValue: string;
  scope: SecretScope;
  projectId: string | null;
  userId: string | null;
  allowedActors: SecretAccessLevel[];
  description: string | null;
  rotatedAt: Date | null;
}

interface ServiceSecretDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<ServiceSecretRecord | null>;
  findUnique(args: { where: { id: string } }): Promise<ServiceSecretRecord | null>;
  findMany(args?: { where?: Record<string, unknown>; orderBy?: Array<Record<string, "asc" | "desc">> }): Promise<ServiceSecretRecord[]>;
  create(args: {
    data: {
      serviceName: string;
      key: string;
      encryptedValue: string;
      scope: SecretScope;
      projectId?: string | null;
      userId?: string | null;
      allowedActors: SecretAccessLevel[];
      description?: string | null;
      rotatedAt?: Date | null;
    };
  }): Promise<ServiceSecretRecord>;
  update(args: {
    where: { id: string };
    data: Partial<{
      encryptedValue: string;
      allowedActors: SecretAccessLevel[];
      description: string | null;
      rotatedAt: Date | null;
    }>;
  }): Promise<ServiceSecretRecord>;
  delete(args: { where: { id: string } }): Promise<ServiceSecretRecord>;
}

interface PrismaSecretsServiceDbLike {
  serviceSecret: ServiceSecretDelegate;
}

export interface PrismaSecretsServiceOptions {
  db?: PrismaSecretsServiceDbLike;
  encryptionKeyHex?: string;
}

export class PrismaSecretsService implements SecretsService {
  private readonly db: PrismaSecretsServiceDbLike;
  private readonly encryptionKey: Buffer;

  constructor(options: PrismaSecretsServiceOptions = {}) {
    this.db = (options.db ?? (prisma as PrismaClient)) as PrismaSecretsServiceDbLike;
    this.encryptionKey = resolveEncryptionKey(options.encryptionKeyHex ?? process.env.SECRETS_ENCRYPTION_KEY);
  }

  async store(input: StoreSecretInput): Promise<void> {
    validateStoreInput(input);

    const encryptedValue = encryptValue(input.value, this.encryptionKey);
    const existing = await this.db.serviceSecret.findFirst({
      where: {
        serviceName: input.serviceName,
        key: input.key,
        scope: input.scope,
        projectId: input.projectId ?? null,
        userId: input.userId ?? null
      }
    });

    if (existing) {
      await this.db.serviceSecret.update({
        where: { id: existing.id },
        data: {
          encryptedValue,
          allowedActors: input.allowedActors,
          description: input.description ?? null
        }
      });
      return;
    }

    await this.db.serviceSecret.create({
      data: {
        serviceName: input.serviceName,
        key: input.key,
        encryptedValue,
        scope: input.scope,
        projectId: input.projectId ?? null,
        userId: input.userId ?? null,
        allowedActors: input.allowedActors,
        description: input.description ?? null
      }
    });
  }

  async getReference(serviceName: string, key?: string): Promise<SecretReference[]> {
    const secrets = await this.db.serviceSecret.findMany({
      where: {
        serviceName,
        ...(key ? { key } : {})
      },
      orderBy: [{ serviceName: "asc" }, { key: "asc" }, { scope: "asc" }]
    });

    return secrets.map((secret) => ({
      id: secret.id,
      serviceName: secret.serviceName,
      key: secret.key,
      description: secret.description,
      scope: secret.scope,
      allowedActors: secret.allowedActors
    }));
  }

  async getValue(secretId: string, actor: SecretAccessLevel): Promise<string | null> {
    const secret = await this.db.serviceSecret.findUnique({ where: { id: secretId } });
    if (!secret || !secret.allowedActors.includes(actor)) {
      return null;
    }

    return decryptValue(secret.encryptedValue, this.encryptionKey);
  }

  async getEnvBundle(
    serviceName: string,
    actor: SecretAccessLevel,
    projectId?: string
  ): Promise<Record<string, string>> {
    const secrets = await this.db.serviceSecret.findMany({
      where: {
        serviceName
      },
      orderBy: [{ scope: "asc" }, { key: "asc" }]
    });

    const bundle: Record<string, string> = {};
    for (const secret of selectInjectableSecrets(secrets, actor, projectId)) {
      bundle[`${toEnvSegment(secret.serviceName)}_${toEnvSegment(secret.key)}`] = decryptValue(
        secret.encryptedValue,
        this.encryptionKey
      );
    }

    return bundle;
  }

  async listServices(): Promise<ServiceInfo[]> {
    const secrets = await this.db.serviceSecret.findMany({
      orderBy: [{ serviceName: "asc" }, { scope: "asc" }, { key: "asc" }]
    });
    const counts = new Map<string, ServiceInfo>();

    for (const secret of secrets) {
      const mapKey = `${secret.serviceName}:${secret.scope}`;
      const existing = counts.get(mapKey);
      if (existing) {
        existing.keyCount += 1;
        continue;
      }

      counts.set(mapKey, {
        serviceName: secret.serviceName,
        keyCount: 1,
        scope: secret.scope
      });
    }

    return [...counts.values()];
  }

  async rotate(secretId: string, newValue: string): Promise<void> {
    await this.db.serviceSecret.update({
      where: { id: secretId },
      data: {
        encryptedValue: encryptValue(newValue, this.encryptionKey),
        rotatedAt: new Date()
      }
    });
  }

  async delete(secretId: string): Promise<void> {
    await this.db.serviceSecret.delete({ where: { id: secretId } });
  }
}

function selectInjectableSecrets(
  secrets: ServiceSecretRecord[],
  actor: SecretAccessLevel,
  projectId?: string
): ServiceSecretRecord[] {
  const selected = new Map<string, ServiceSecretRecord>();

  for (const secret of secrets) {
    if (!secret.allowedActors.includes(actor)) {
      continue;
    }

    if (secret.scope === "project") {
      if (!projectId || secret.projectId !== projectId) {
        continue;
      }
    } else if (secret.scope !== "global") {
      continue;
    }

    const existing = selected.get(secret.key);
    if (!existing || scopeWeight(secret.scope) >= scopeWeight(existing.scope)) {
      selected.set(secret.key, secret);
    }
  }

  return [...selected.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function scopeWeight(scope: SecretScope) {
  switch (scope) {
    case "project":
      return 2;
    case "user":
      return 3;
    case "global":
    default:
      return 1;
  }
}

function validateStoreInput(input: StoreSecretInput) {
  if (input.scope === "project" && !input.projectId) {
    throw new Error("projectId is required for project-scoped secrets");
  }

  if (input.scope === "user" && !input.userId) {
    throw new Error("userId is required for user-scoped secrets");
  }
}

function resolveEncryptionKey(encryptionKeyHex?: string): Buffer {
  if (encryptionKeyHex) {
    const normalized = encryptionKeyHex.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
      throw new Error("SECRETS_ENCRYPTION_KEY must be a 32-byte hex string");
    }

    return Buffer.from(normalized, "hex");
  }

  const generated = randomBytes(32);
  console.warn(
    `SECRETS_ENCRYPTION_KEY is not set. Generated an ephemeral key for this process: ${generated.toString("hex")}`
  );
  return generated;
}

function encryptValue(value: string, encryptionKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
  return Buffer.from(payload, "utf8").toString("base64");
}

function decryptValue(encryptedValue: string, encryptionKey: Buffer): string {
  const decoded = Buffer.from(encryptedValue, "base64").toString("utf8");
  const [ivBase64, authTagBase64, ciphertextBase64] = decoded.split(":");
  if (!ivBase64 || !authTagBase64 || !ciphertextBase64) {
    throw new Error("Invalid encrypted secret payload");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextBase64, "base64")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

function toEnvSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export const __private__ = {
  decryptValue,
  encryptValue,
  resolveEncryptionKey
};
