import { AzureOpenAITranscriber } from "./azure-openai";
import type { TranscriptionConfig } from "./config";
import type { Transcriber } from "./transcription";

export function createTranscriber(config: TranscriptionConfig): Transcriber {
  return new AzureOpenAITranscriber(config.provider);
}
