import { localModels, type ManagerState } from '../localModels/LocalModelManager'
import type { ModelSize } from './modelManager'

export type ServerState = ManagerState

export interface LlmServerOptions {
  modelSize?: ModelSize
  port?: number
  threads?: number
  ctxSize?: number
}

export function onServerStateChange(fn: (s: ServerState) => void): () => void {
  return localModels.onStateChange(fn)
}

export function getServerState(): ServerState { return localModels.getState() }
export function getServerPort(): number { return localModels.getPort() }
export function getBaseUrl(): string { return localModels.getBaseUrl() }

export async function startServer(opts: LlmServerOptions = {}): Promise<boolean> {
  if (opts.modelSize) localModels.setModelSize(opts.modelSize)
  return localModels.ensureReady()
}

export function stopServer(): void { localModels.shutdown() }
