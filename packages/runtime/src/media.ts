import type { GeneratedImages, ImageRequest } from './omp/runtime.ts'
import { prompts } from './prompts.ts'

/** Spoken text as a file. */
export interface SpokenFile {
  readonly audio: Uint8Array
  readonly mimeType: string
  /** The voice that spoke it, as Settings → Voice names it. */
  readonly voice: string
}

/** Pictures and speech for agents (generate_image, tts): the person's image model and their Settings → Voice voice. */
export interface MediaTools {
  generateImage(request: ImageRequest, signal?: AbortSignal): Promise<GeneratedImages>
  speak(text: string, signal?: AbortSignal): Promise<SpokenFile>
}

/** omp's image models, as the omp runtime offers them. */
export interface ImageModels {
  imageModels(): string[]
  generateImage(
    request: ImageRequest,
    options?: { model?: string; signal?: AbortSignal },
  ): Promise<GeneratedImages>
}

/** Text to speech in the voice chosen in Settings → Voice (the gateway's VoiceHub). */
export interface VoiceFiles {
  speakFile(text: string, signal?: AbortSignal): Promise<{ audio: Uint8Array; voice: string }>
}

/**
 * `imageModel`: the model chosen in Settings → Tools (`provider/id`), or none for the first that can. `voice`: the
 * gateway's voice engines, which start after the chats do, so they are looked up on each call.
 */
export function ompMediaTools(options: {
  images: ImageModels
  imageModel: () => string | undefined
  voice: () => VoiceFiles | undefined
}): MediaTools {
  return {
    async generateImage(request, signal) {
      const chosen = options.imageModel()
      // Said before anything is tried, with how to set one up: an agent cannot fix this, the person can.
      if (!chosen && options.images.imageModels().length === 0)
        throw new Error(prompts.toolResults.noImageModel)
      if (chosen && !options.images.imageModels().includes(chosen))
        throw new Error(prompts.toolResults.imageModelGone(chosen))
      return options.images.generateImage(request, {
        ...(chosen ? { model: chosen } : {}),
        ...(signal ? { signal } : {}),
      })
    },
    async speak(text, signal) {
      const voice = options.voice()
      if (!voice) throw new Error(prompts.toolResults.noVoice)
      const { audio, voice: name } = await voice.speakFile(text, signal)
      return { audio, mimeType: 'audio/wav', voice: name }
    },
  }
}
