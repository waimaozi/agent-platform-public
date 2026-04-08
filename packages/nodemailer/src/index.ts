import { Socket, connect as connectTcp } from "node:net";
import { connect as connectTls, TLSSocket } from "node:tls";

export interface TransportMailOptions {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export interface TransportOptions {
  host: string;
  port: number;
  secure?: boolean;
  auth?: {
    user: string;
    pass: string;
  };
}

export interface Transporter {
  sendMail(input: TransportMailOptions): Promise<void>;
}

type ReadableSocket = Socket | TLSSocket;

export function createTransport(options: TransportOptions): Transporter {
  return {
    async sendMail(input: TransportMailOptions): Promise<void> {
      const socket = await openSmtpConnection(options);
      try {
        await readResponse(socket);
        await sendCommand(socket, `EHLO ${options.host}`);

        let activeSocket = socket;
        if (!options.secure) {
          const capabilities = await readResponse(activeSocket);
          if (capabilities.text.includes("STARTTLS")) {
            await writeLine(activeSocket, "STARTTLS");
            await readResponse(activeSocket);
            activeSocket = await upgradeToTls(activeSocket, options.host);
            await writeLine(activeSocket, `EHLO ${options.host}`);
            await readResponse(activeSocket);
          }
        } else {
          await readResponse(activeSocket);
        }

        if (options.auth?.user && options.auth.pass) {
          await writeLine(activeSocket, "AUTH LOGIN");
          await readResponse(activeSocket);
          await writeLine(activeSocket, Buffer.from(options.auth.user).toString("base64"));
          await readResponse(activeSocket);
          await writeLine(activeSocket, Buffer.from(options.auth.pass).toString("base64"));
          await readResponse(activeSocket);
        }

        await sendCommand(activeSocket, `MAIL FROM:<${extractAddress(input.from)}>`);
        await sendCommand(activeSocket, `RCPT TO:<${extractAddress(input.to)}>`);
        await writeLine(activeSocket, "DATA");
        await expectCode(await readResponse(activeSocket), 354);
        await writeLine(activeSocket, buildMimeMessage(input));
        await writeLine(activeSocket, ".");
        await readResponse(activeSocket);
        await writeLine(activeSocket, "QUIT");
      } finally {
        socket.destroy();
      }
    }
  };
}

async function openSmtpConnection(options: TransportOptions): Promise<ReadableSocket> {
  if (options.secure) {
    return await new Promise<ReadableSocket>((resolve, reject) => {
      const socket = connectTls({
        host: options.host,
        port: options.port,
        servername: options.host
      }, () => resolve(socket));
      socket.once("error", reject);
    });
  }

  return await new Promise<ReadableSocket>((resolve, reject) => {
    const socket = connectTcp({
      host: options.host,
      port: options.port
    }, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function upgradeToTls(socket: ReadableSocket, host: string): Promise<ReadableSocket> {
  return await new Promise<ReadableSocket>((resolve, reject) => {
    const tlsSocket = connectTls({
      socket,
      servername: host
    }, () => resolve(tlsSocket));
    tlsSocket.once("error", reject);
  });
}

async function sendCommand(socket: ReadableSocket, command: string) {
  await writeLine(socket, command);
  await readResponse(socket);
}

async function writeLine(socket: ReadableSocket, line: string) {
  await new Promise<void>((resolve, reject) => {
    socket.write(`${line}\r\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readResponse(socket: ReadableSocket): Promise<{ code: number; text: string }> {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split("\r\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (!lastLine || !/^\d{3}[ -]/.test(lastLine)) {
        return;
      }
      const code = Number(lastLine.slice(0, 3));
      if (lastLine[3] === "-") {
        return;
      }
      cleanup();
      if (code >= 400) {
        reject(new Error(lines.join("\n")));
        return;
      }
      resolve({ code, text: lines.join("\n") });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function expectCode(response: { code: number; text: string }, expected: number) {
  if (response.code !== expected) {
    throw new Error(response.text);
  }
}

function buildMimeMessage(input: TransportMailOptions) {
  const boundary = `agent-${Date.now().toString(16)}`;
  const plainBody = normalizeSmtpBody(input.text ?? input.html ?? "");
  const htmlBody = input.html ? normalizeSmtpBody(input.html) : null;

  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0"
  ];

  if (htmlBody) {
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      plainBody,
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      htmlBody,
      `--${boundary}--`
    ].join("\r\n");
  }

  return [
    ...headers,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    plainBody
  ].join("\r\n");
}

function normalizeSmtpBody(value: string) {
  return value
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function extractAddress(value: string) {
  const match = value.match(/<([^>]+)>/);
  return match?.[1] ?? value.trim();
}
