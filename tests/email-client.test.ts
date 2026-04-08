import { beforeEach, describe, expect, it, vi } from "vitest";

const createTransportMock = vi.fn();
const sendMailMock = vi.fn();

vi.mock("nodemailer", () => ({
  createTransport: createTransportMock
}));

describe("SmtpEmailClient", () => {
  beforeEach(() => {
    sendMailMock.mockReset();
    createTransportMock.mockReset();
    createTransportMock.mockReturnValue({
      sendMail: sendMailMock
    });
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
  });

  it("creates a transport from constructor and env defaults", async () => {
    process.env.SMTP_PASS = "env-pass";
    const { SmtpEmailClient } = await import("../packages/integrations/src/email/client.js");

    new SmtpEmailClient();

    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: {
        user: "test@example.com",
        pass: "env-pass"
      }
    });
  });

  it("formats and sends the message correctly", async () => {
    const { SmtpEmailClient } = await import("../packages/integrations/src/email/client.js");
    const client = new SmtpEmailClient({
      host: "smtp.example.com",
      port: 2525,
      user: "user@example.com",
      pass: "secret",
      from: "Agent <agent@example.com>"
    });

    await client.send({
      to: "user@recipient.test",
      subject: "Subject",
      body: "Plain body",
      html: "<p>Plain body</p>"
    });

    expect(sendMailMock).toHaveBeenCalledWith({
      from: "Agent <agent@example.com>",
      to: "user@recipient.test",
      subject: "Subject",
      text: "Plain body",
      html: "<p>Plain body</p>"
    });
  });
});
