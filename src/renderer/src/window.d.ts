import type { SynteeAPI } from '../preload/index'

declare global {
  interface Window {
    syntee: SynteeAPI
  }
}

export {}
