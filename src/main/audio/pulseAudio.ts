import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { AudioControllerInstance, NativeAudioDevice, NativeAudioFormat } from './nativeAudio'

const exec = promisify(execFile)

interface PulseSink {
  name: string
  description: string
  monitor_source: string
  state: string
}

export interface PulseOutput extends NativeAudioDevice {
  source: string
  running: boolean
}

export async function listPulseOutputs(): Promise<PulseOutput[]> {
  const options = { timeout: 2000, maxBuffer: 1024 * 1024 }
  const [listing, defaultSink] = await Promise.all([
    exec('pactl', ['--format=json', 'list', 'sinks'], options),
    exec('pactl', ['get-default-sink'], options).then(result => result.stdout.trim(), () => '')
  ])
  const sinks = JSON.parse(listing.stdout) as PulseSink[]
  return sinks.filter(sink => sink.name && sink.monitor_source).map(sink => ({
    id: sink.name,
    name: sink.description || sink.name,
    type: 'output',
    isDefault: sink.name === defaultSink,
    source: sink.monitor_source,
    running: sink.state === 'RUNNING'
  }))
}

export const pulseCaptureFormat: NativeAudioFormat = {
  sampleRate: 48000,
  channels: 2,
  bitDepth: 16,
  rawBitDepth: 16
}

export function createPulseCapture(output: PulseOutput, sampleRate = pulseCaptureFormat.sampleRate,
  channels = pulseCaptureFormat.channels): AudioControllerInstance {
  let child: ReturnType<typeof spawn> | null = null
  return {
    start(_config, callback) {
      const capture = spawn('parec', [
        '--raw', '--format=s16le', `--rate=${sampleRate}`, `--channels=${channels}`,
        '--latency-msec=32', `--device=${output.source}`
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      child = capture
      let pending: Buffer = Buffer.alloc(0)
      let diagnostic = ''
      const frameBytes = channels * 2
      capture.stdout.on('data', (chunk: Buffer) => {
        if (child !== capture) return
        const data = pending.length ? Buffer.concat([pending, chunk]) : chunk
        const end = data.length - (data.length % frameBytes)
        pending = data.subarray(end)
        if (end > 0) callback(null, data.subarray(0, end))
      })
      capture.stderr.setEncoding('utf8').on('data', (text: string) => {
        diagnostic = (diagnostic + text).slice(-2048)
      })
      const fail = (error: Error): void => {
        if (child !== capture) return
        child = null
        callback(error, null)
      }
      capture.once('error', fail)
      capture.once('close', (code, signal) => {
        fail(new Error(diagnostic.trim() || `parec завершился (${code ?? signal})`))
      })
    },
    stop() {
      const capture = child
      child = null
      capture?.kill()
    }
  }
}
