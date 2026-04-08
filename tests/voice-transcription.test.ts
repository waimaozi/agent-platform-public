import { beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeTelegramVoiceNote } from "../apps/api/src/lib/voice-notes.js";

describe("voice transcription", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads the Telegram file and transcribes it with Groq", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("getFile")) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { file_path: "voice/file.ogg" } })
        };
      }
      if (url.includes("/file/bottest/")) {
        return {
          ok: true,
          arrayBuffer: async () => new TextEncoder().encode("audio").buffer
        };
      }
      return {
        ok: true,
        json: async () => ({ text: "Transcribed voice note" })
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeTelegramVoiceNote({
      botToken: "test",
      groqApiKey: "groq",
      voice: {
        file_id: "voice-1",
        duration: 3,
        mime_type: "audio/ogg"
      }
    });

    expect(result.text).toBe("Transcribed voice note");
    expect(result.filePath).toBe("voice/file.ogg");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
