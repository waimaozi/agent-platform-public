export interface TelegramVoiceDescriptor {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface VoiceTranscriptionResult {
  text: string;
  filePath: string;
}

export async function transcribeTelegramVoiceNote(input: {
  botToken: string;
  voice: TelegramVoiceDescriptor;
  groqApiKey: string;
  apiBaseUrl?: string;
  groqApiUrl?: string;
}): Promise<VoiceTranscriptionResult> {
  const apiBaseUrl = input.apiBaseUrl ?? "https://api.telegram.org";
  const groqApiUrl = input.groqApiUrl ?? "https://api.groq.com/openai/v1/audio/transcriptions";

  const fileResponse = await fetch(`${apiBaseUrl}/bot${input.botToken}/getFile?file_id=${input.voice.file_id}`);
  if (!fileResponse.ok) {
    throw new Error(`Telegram getFile failed with ${fileResponse.status}`);
  }

  const filePayload = (await fileResponse.json()) as {
    ok?: boolean;
    result?: { file_path?: string };
  };
  const filePath = filePayload.result?.file_path;
  if (!filePayload.ok || !filePath) {
    throw new Error("Telegram getFile response missing file_path");
  }

  const downloadResponse = await fetch(`${apiBaseUrl}/file/bot${input.botToken}/${filePath}`);
  if (!downloadResponse.ok) {
    throw new Error(`Telegram file download failed with ${downloadResponse.status}`);
  }

  const audioBuffer = await downloadResponse.arrayBuffer();
  const form = new FormData();
  form.set("model", "whisper-large-v3");
  form.set("file", new Blob([audioBuffer], { type: input.voice.mime_type ?? "audio/ogg" }), `${input.voice.file_id}.ogg`);

  const transcriptionResponse = await fetch(groqApiUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.groqApiKey}`
    },
    body: form
  });
  if (!transcriptionResponse.ok) {
    throw new Error(`Groq transcription failed with ${transcriptionResponse.status}`);
  }

  const transcriptionPayload = (await transcriptionResponse.json()) as { text?: string };
  if (!transcriptionPayload.text?.trim()) {
    throw new Error("Groq transcription returned empty text");
  }

  return {
    text: transcriptionPayload.text.trim(),
    filePath
  };
}
