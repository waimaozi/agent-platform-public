import { createTransport, type Transporter } from "nodemailer";
import type { SecretsService } from "@agent-platform/secrets-service";

export interface EmailClient {
  send(input: SendEmailInput): Promise<void>;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  html?: string;
}

export interface SmtpEmailClientOptions {
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  from?: string;
}

export class SmtpEmailClient implements EmailClient {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(options?: SmtpEmailClientOptions) {
    this.transporter = createTransport({
      host: options?.host ?? process.env.SMTP_HOST ?? "smtp.gmail.com",
      port: options?.port ?? Number(process.env.SMTP_PORT ?? 587),
      secure: false,
      auth: {
        user: options?.user ?? process.env.SMTP_USER ?? "your-email@gmail.com",
        pass: options?.pass ?? process.env.SMTP_PASS ?? ""
      }
    });
    this.from = options?.from ?? process.env.SMTP_FROM ?? "Assistant <your-email@gmail.com>";
  }

  async send(input: SendEmailInput): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: input.subject,
      text: input.body,
      html: input.html
    });
  }
}

export async function resolveSmtpPassword(
  secretsService?: Pick<SecretsService, "getReference" | "getValue">
): Promise<string> {
  const envPass = process.env.SMTP_PASS ?? "";
  if (!secretsService) {
    return envPass;
  }

  const candidates = [
    ["smtp", "pass"],
    ["smtp", "SMTP_PASS"],
    ["gmail", "app_password"],
    ["gmail", "smtp_pass"]
  ] as const;

  for (const [serviceName, key] of candidates) {
    const references = await secretsService.getReference(serviceName, key);
    const match = references.find((reference) => reference.allowedActors.includes("direct_read"));
    if (!match) {
      continue;
    }

    const value = await secretsService.getValue(match.id, "direct_read");
    if (value) {
      return value;
    }
  }

  return envPass;
}
