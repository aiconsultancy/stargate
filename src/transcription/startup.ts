import { AzureOpenAITranscriber } from "./azure-openai";
import type { Transcriber, TranscriptionConfig } from "./transcription";

export function createTranscriber(config: TranscriptionConfig): Transcriber {
  return new AzureOpenAITranscriber(config.provider);
}
