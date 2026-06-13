export interface ImageModel {
  id: string
  name: string
  provider: string
  sizes: string[]
  defaultSize: string
  notes?: string
  supportsQuality?: boolean
  supportsStyle?: boolean
}

export const IMAGE_MODELS: ImageModel[] = [
  // ── OpenAI ───────────────────────────────────────────────────
  {
    id: 'dall-e-3',
    name: 'DALL-E 3',
    provider: 'OpenAI',
    sizes: ['1024x1024', '1792x1024', '1024x1792'],
    defaultSize: '1024x1024',
    supportsQuality: true,
    supportsStyle: true,
    notes: 'High quality, style fidelity. quality: standard|hd, style: vivid|natural',
  },
  {
    id: 'dall-e-2',
    name: 'DALL-E 2',
    provider: 'OpenAI',
    sizes: ['256x256', '512x512', '1024x1024'],
    defaultSize: '1024x1024',
    notes: 'Supports image edits and variations',
  },
  {
    id: 'gpt-image-1',
    name: 'GPT Image 1',
    provider: 'OpenAI',
    sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    defaultSize: '1024x1024',
    supportsQuality: true,
    notes: 'Latest OpenAI model. quality: low|medium|high|auto',
  },
  // ── Black Forest Labs (FLUX) ──────────────────────────────────
  {
    id: 'flux-pro-1.1-ultra',
    name: 'FLUX 1.1 Pro Ultra',
    provider: 'Black Forest Labs',
    sizes: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', '9:21'],
    defaultSize: '1:1',
    notes: 'Highest quality, up to 4MP. Uses aspect_ratio. API: api.bfl.ai, x-key auth',
  },
  {
    id: 'flux-pro-1.1',
    name: 'FLUX 1.1 Pro',
    provider: 'Black Forest Labs',
    sizes: ['1024x1024', '1024x768', '768x1024', '1280x720', '720x1280'],
    defaultSize: '1024x1024',
    notes: '3x faster than flux-pro with higher quality. API: api.bfl.ai',
  },
  {
    id: 'flux-pro',
    name: 'FLUX.1 Pro',
    provider: 'Black Forest Labs',
    sizes: ['1024x1024', '1024x768', '768x1024', '1280x720', '720x1280'],
    defaultSize: '1024x1024',
    notes: 'Standard quality. API: api.bfl.ai, x-key auth',
  },
  {
    id: 'flux-dev',
    name: 'FLUX.1 Dev',
    provider: 'Black Forest Labs',
    sizes: ['1024x1024', '1024x768', '768x1024'],
    defaultSize: '1024x1024',
    notes: 'Research/non-commercial. API: api.bfl.ai',
  },
  {
    id: 'flux-schnell',
    name: 'FLUX.1 Schnell',
    provider: 'Black Forest Labs',
    sizes: ['1024x1024', '1024x768', '768x1024'],
    defaultSize: '1024x1024',
    notes: 'Fastest. Non-commercial license. API: api.bfl.ai',
  },
  // ── Together AI ───────────────────────────────────────────────
  {
    id: 'black-forest-labs/FLUX.1-schnell',
    name: 'FLUX.1 Schnell (Together)',
    provider: 'Together AI',
    sizes: ['512x512', '1024x1024', '1280x720', '720x1280', '2048x2048'],
    defaultSize: '1024x1024',
    notes: 'OpenAI-compatible. Base URL: api.together.xyz/v1',
  },
  {
    id: 'black-forest-labs/FLUX.1-dev',
    name: 'FLUX.1 Dev (Together)',
    provider: 'Together AI',
    sizes: ['512x512', '1024x1024', '1280x720', '720x1280'],
    defaultSize: '1024x1024',
    notes: 'OpenAI-compatible. Base URL: api.together.xyz/v1',
  },
  {
    id: 'black-forest-labs/FLUX.1.1-pro',
    name: 'FLUX 1.1 Pro (Together)',
    provider: 'Together AI',
    sizes: ['512x512', '1024x1024', '1280x720', '720x1280', '2048x2048'],
    defaultSize: '1024x1024',
    notes: 'Latest pro on Together AI. OpenAI-compatible',
  },
  {
    id: 'stabilityai/stable-diffusion-xl-base-1.0',
    name: 'Stable Diffusion XL (Together)',
    provider: 'Together AI',
    sizes: ['512x512', '768x768', '1024x1024'],
    defaultSize: '1024x1024',
    notes: 'SDXL 1.0. OpenAI-compatible. Base URL: api.together.xyz/v1',
  },
  // ── Replicate ─────────────────────────────────────────────────
  {
    id: 'black-forest-labs/flux-schnell',
    name: 'FLUX.1 Schnell (Replicate)',
    provider: 'Replicate',
    sizes: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    defaultSize: '1:1',
    notes: 'OpenAI-compatible. Base URL: api.replicate.com/openai/v1',
  },
  {
    id: 'black-forest-labs/flux-1.1-pro',
    name: 'FLUX 1.1 Pro (Replicate)',
    provider: 'Replicate',
    sizes: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    defaultSize: '1:1',
    notes: 'OpenAI-compatible. Base URL: api.replicate.com/openai/v1',
  },
  // ── FAL.ai ────────────────────────────────────────────────────
  {
    id: 'fal-ai/flux/schnell',
    name: 'FLUX.1 Schnell (FAL)',
    provider: 'FAL.ai',
    sizes: ['1024x1024', '1024x768', '768x1024'],
    defaultSize: '1024x1024',
    notes: 'OpenAI-compatible. Base URL: fal.run/openai/v1',
  },
  {
    id: 'fal-ai/flux-pro/v1.1-ultra',
    name: 'FLUX 1.1 Pro Ultra (FAL)',
    provider: 'FAL.ai',
    sizes: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    defaultSize: '1:1',
    notes: 'Highest quality FAL. OpenAI-compatible. Base URL: fal.run/openai/v1',
  },
]

export function getImageModel(id: string): ImageModel | undefined {
  return IMAGE_MODELS.find(m => m.id === id)
}

export function getImageModelsByProvider(): Record<string, ImageModel[]> {
  return IMAGE_MODELS.reduce((acc, m) => {
    if (!acc[m.provider]) acc[m.provider] = []
    acc[m.provider].push(m)
    return acc
  }, {} as Record<string, ImageModel[]>)
}
