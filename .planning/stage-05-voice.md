# СТАДИЯ 05 — ГОЛОС

> Цель: полноценный голосовой режим. Wake word "Синти" запускает оверлей,
> Syntee слушает команду, отвечает голосом, видит экран каждые 5 секунд.

---

## ЧТО БУДЕТ ГОТОВО ПОСЛЕ СТАДИИ

- Vosk офлайн wake word "Синти" — всегда работает в фоне
- После wake word: говорит "Слушаю" + голосовой оверлей в правом нижнем углу
- Пульсирующая волна (CSS animation) — когда слушает
- Звуковая волна от логотипа — когда говорит
- STT через gemini-3-flash — речь в текст
- TTS через gemini-3-flash — текст в речь
- В голосовом режиме: скриншот экрана каждые 5 секунд в контекст
- Голосовые команды агенту во время работы: "стоп", "назад", "подожди"
- Ctrl+Shift+V toggle голосового режима
- Распознавание эмоций: анализ текста и тона → адаптация ответа
- Многоязычность: "switch to english" / "переключись на русский"
- В чате: TTS только по кнопке озвучки

---

## ТЕХНОЛОГИИ ЭТОЙ СТАДИИ

```
vosk — офлайн STT для wake word (vosk-model-small-ru-0.22)
node-record-lpcm16 — запись с микрофона
sox — аудио обработка (нужен отдельно на Windows)
```

---

## ЗАДАЧИ

### 1. Установка Vosk модели

```
Скачать: https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip
Распаковать в: assets/models/vosk-model-small-ru/
Размер: ~45MB — включить в установщик
```

### 2. WakeWordDetector.ts

```typescript
// src/core/voice/WakeWordDetector.ts
import { Readable } from 'stream'
import { EventEmitter } from 'events'

// Vosk через Node.js биндинги vosk-browser или napi-rs биндинги
// Для Windows: npm install vosk

export class WakeWordDetector extends EventEmitter {
  private model: any
  private recognizer: any
  private audioStream: any
  private isListening = false
  private wakeWord: string

  constructor(wakeWord = 'синти') {
    super()
    this.wakeWord = wakeWord.toLowerCase()
  }

  async init(): Promise<void> {
    const vosk = require('vosk')
    const path = require('path')
    const modelPath = path.join(process.resourcesPath ?? __dirname, 
      '../../assets/models/vosk-model-small-ru')
    
    vosk.setLogLevel(-1) // отключить логи
    this.model = new vosk.Model(modelPath)
    this.recognizer = new vosk.Recognizer({ model: this.model, sampleRate: 16000 })
  }

  start(): void {
    const recorder = require('node-record-lpcm16')
    
    this.audioStream = recorder.record({
      sampleRate: 16000,
      channels: 1,
      audioType: 'raw',
    })

    this.isListening = true
    
    this.audioStream.stream().on('data', (data: Buffer) => {
      if (this.recognizer.acceptWaveform(data)) {
        const result = JSON.parse(this.recognizer.result())
        const text = result.text?.toLowerCase() ?? ''
        
        if (text.includes(this.wakeWord)) {
          this.emit('wake', text)
        }
      }
    })
  }

  stop(): void {
    this.audioStream?.stop()
    this.isListening = false
  }

  get active() { return this.isListening }
}
```

### 3. AudioCapture.ts — запись команды

```typescript
// src/core/voice/AudioCapture.ts
import { EventEmitter } from 'events'
import path from 'path'
import { app } from 'electron'
import { v4 as uuidv4 } from 'uuid'

export class AudioCapture extends EventEmitter {
  private recorder: any
  private isRecording = false

  // Записать до тишины (VAD - Voice Activity Detection)
  async recordUntilSilence(params: {
    maxDuration?: number  // мс, по умолчанию 10000
    silenceThreshold?: number
    silenceDuration?: number  // мс тишины для остановки
  } = {}): Promise<string> {
    const { maxDuration = 10000, silenceDuration = 1500 } = params
    const recorder = require('node-record-lpcm16')
    const fs = require('fs')
    
    const outputPath = path.join(app.getPath('temp'), `syntee-voice-${uuidv4()}.wav`)
    const outputStream = fs.createWriteStream(outputPath)
    
    return new Promise((resolve, reject) => {
      this.recorder = recorder.record({ sampleRate: 16000, channels: 1 })
      this.isRecording = true
      
      this.recorder.stream().pipe(outputStream)
      
      // Стоп по максимальной длительности
      const timeout = setTimeout(() => {
        this.stopRecording(outputPath, resolve)
      }, maxDuration)

      this.once('stop', () => {
        clearTimeout(timeout)
        this.stopRecording(outputPath, resolve)
      })
    })
  }

  stopRecording(outputPath: string, resolve: (path: string) => void) {
    this.recorder?.stop()
    this.isRecording = false
    setTimeout(() => resolve(outputPath), 200)
  }

  stop() { this.emit('stop') }
  get recording() { return this.isRecording }
}
```

### 4. STTService.ts — речь в текст

```typescript
// src/core/ai/STTService.ts
import type { AIClient } from './AIClient'
import type Store from 'electron-store'
import fs from 'fs'

export class STTService {
  constructor(
    private ai: AIClient,
    private store: Store
  ) {}

  async transcribe(audioPath: string): Promise<string> {
    const model = this.store.get('sttModel') as string // gemini-3-flash
    
    // Отправить аудио файл через OpenAI-compatible Audio API
    // Gemini поддерживает audio через multimodal
    const audioBase64 = fs.readFileSync(audioPath).toString('base64')
    
    // Используем gemini через chat completions с аудио
    const result = await this.ai.complete({
      model,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: audioBase64, format: 'wav' }
          },
          { type: 'text', text: 'Транскрибируй речь. Верни только текст.' }
        ] as any
      }],
      temperature: 0.1,
    })
    
    return result.trim()
  }
}
```

### 5. TTSService.ts — текст в речь

```typescript
// src/core/ai/TTSService.ts
import type { AIClient } from './AIClient'
import type Store from 'electron-store'
import path from 'path'
import { app } from 'electron'
import { v4 as uuidv4 } from 'uuid'

export class TTSService {
  constructor(
    private ai: AIClient,
    private store: Store
  ) {}

  async synthesize(text: string): Promise<string> {
    const model = this.store.get('ttsModel') as string // gemini-3-flash
    const voice = this.store.get('voiceId') as string ?? 'alloy'
    
    // OpenAI-compatible TTS endpoint
    const client = (this.ai as any).client
    const mp3 = await client.audio.speech.create({
      model: 'tts-1',
      voice: voice,
      input: text,
    })
    
    const outputPath = path.join(app.getPath('temp'), `syntee-tts-${uuidv4()}.mp3`)
    const buffer = Buffer.from(await mp3.arrayBuffer())
    require('fs').writeFileSync(outputPath, buffer)
    return outputPath
  }

  // Воспроизвести аудио файл
  async play(audioPath: string): Promise<void> {
    return new Promise((resolve) => {
      const { exec } = require('child_process')
      // Windows: встроенный Media Player через PowerShell
      exec(`powershell -c "(New-Object Media.SoundPlayer '${audioPath}').PlaySync()"`, 
        () => resolve()
      )
    })
  }

  async speakText(text: string): Promise<void> {
    const audioPath = await this.synthesize(text)
    await this.play(audioPath)
  }
}
```

### 6. VoiceSession.ts — управление голосовой сессией

```typescript
// src/core/voice/VoiceSession.ts
import { EventEmitter } from 'events'
import type { WakeWordDetector } from './WakeWordDetector'
import type { AudioCapture } from './AudioCapture'
import type { STTService } from '../ai/STTService'
import type { TTSService } from '../ai/TTSService'
import type { ChatService } from '../ai/ChatService'
import type { ScreenCapture } from '../screen/ScreenCapture'

export class VoiceSession extends EventEmitter {
  private screenInterval: NodeJS.Timeout | null = null
  private currentScreenshot: string | null = null
  private activeChatId: string | null = null

  constructor(
    private wakeWord: WakeWordDetector,
    private audio: AudioCapture,
    private stt: STTService,
    private tts: TTSService,
    private chat: ChatService,
    private screen: ScreenCapture,
  ) {
    super()
    this.setupWakeWord()
  }

  private setupWakeWord() {
    this.wakeWord.on('wake', async () => {
      await this.startSession()
    })
  }

  async startSession(): Promise<void> {
    // Показать голосовой оверлей
    this.emit('session:start')
    
    // Сказать "Слушаю"
    await this.tts.speakText('Слушаю')
    
    // Начать скриншоты каждые 5 секунд
    this.startScreenMonitoring()
    
    // Записать команду
    this.emit('recording:start')
    const audioPath = await this.audio.recordUntilSilence({ maxDuration: 10000 })
    this.emit('recording:done')
    
    // STT
    const text = await this.stt.transcribe(audioPath)
    if (!text) return this.endSession()
    
    this.emit('transcribed', text)
    
    // Отправить в чат с контекстом экрана
    const chatId = this.activeChatId ?? this.chat.createChat()
    this.activeChatId = chatId
    
    // Добавить скриншот к сообщению если есть
    const params = {
      chatId,
      content: text,
      screenContext: this.currentScreenshot,
    }
    
    let fullResponse = ''
    this.emit('response:start')
    
    for await (const chunk of this.chat.sendMessage(params)) {
      if (chunk.type === 'token') {
        fullResponse += chunk.data
        this.emit('response:token', chunk.data)
      }
    }
    
    this.emit('response:done', fullResponse)
    
    // Озвучить ответ
    await this.tts.speakText(fullResponse)
    
    // Ждать следующей команды или тишины
    this.endSession()
  }

  private startScreenMonitoring() {
    this.screenInterval = setInterval(async () => {
      this.currentScreenshot = await this.screen.captureFullScreen()
    }, 5000)
  }

  endSession() {
    if (this.screenInterval) {
      clearInterval(this.screenInterval)
      this.screenInterval = null
    }
    this.emit('session:end')
  }

  // Голосовые команды агенту во время работы
  processVoiceCommand(command: string): boolean {
    const lower = command.toLowerCase()
    if (lower.includes('стоп') || lower.includes('остановись')) {
      this.emit('agent:stop')
      return true
    }
    if (lower.includes('подожди') || lower.includes('пауза')) {
      this.emit('agent:pause')
      return true
    }
    if (lower.includes('назад') || lower.includes('отмени')) {
      this.emit('agent:undo')
      return true
    }
    return false
  }
}
```

### 7. EmotionDetector.ts

```typescript
// src/core/voice/EmotionDetector.ts
import type { AIClient } from '../ai/AIClient'

type Emotion = 'neutral' | 'happy' | 'frustrated' | 'tired' | 'excited' | 'sad'

export class EmotionDetector {
  constructor(private ai: AIClient) {}

  // Анализ текста на эмоции
  async detectFromText(text: string): Promise<Emotion> {
    const result = await this.ai.complete({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Определи эмоцию в тексте. Ответь одним словом из списка: neutral, happy, frustrated, tired, excited, sad.
Текст: "${text}"`
      }],
      temperature: 0.1,
    })
    
    const emotion = result.trim().toLowerCase() as Emotion
    return ['neutral', 'happy', 'frustrated', 'tired', 'excited', 'sad'].includes(emotion)
      ? emotion : 'neutral'
  }

  // Адаптировать системный промпт под эмоцию
  getEmotionContext(emotion: Emotion): string {
    const contexts: Record<Emotion, string> = {
      neutral: '',
      happy: 'Пользователь в хорошем настроении. Будь энергичным и позитивным.',
      frustrated: 'Пользователь раздражён. Будь спокойным, чётким и помогающим. Не шути.',
      tired: 'Пользователь устал. Отвечай кратко и по делу.',
      excited: 'Пользователь взволнован. Поддержи энтузиазм!',
      sad: 'Пользователь расстроен. Будь мягким и поддерживающим.',
    }
    return contexts[emotion]
  }
}
```

### 8. VoiceOverlay UI

```tsx
// src/renderer/pages/Voice/VoiceOverlayPage.tsx
// Небольшое окно 300x300 в правом нижнем углу

import { motion, AnimatePresence } from 'framer-motion'
import { VoiceWave } from '../../components/voice/VoiceWave'
import { SpeakingWave } from '../../components/voice/SpeakingWave'

// VoiceWave — пульсирующие концентрические круги (CSS анимация)
// Скорость и амплитуда пульсации зависит от уровня входного звука

// SpeakingWave — звуковая волна исходящая от логотипа кристалла
// Рябь расходится от центра с анимацией

export function VoiceOverlayPage() {
  // Состояния: idle, listening, processing, speaking
  const [state, setState] = useState('idle')
  const [transcribedText, setTranscribedText] = useState('')
  
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      style={{
        width: 300, height: 300,
        background: 'rgba(10, 10, 10, 0.85)',
        backdropFilter: 'blur(40px)',
        borderRadius: 24,
        border: '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {state === 'listening' && <VoiceWave />}
      {state === 'speaking' && <SpeakingWave />}
      
      <div style={{ color: 'white', marginTop: 16, fontSize: 14 }}>
        {state === 'idle' && 'Скажи "Синти"'}
        {state === 'listening' && 'Слушаю...'}
        {state === 'processing' && 'Думаю...'}
        {state === 'speaking' && 'Syntee говорит...'}
      </div>
      
      {transcribedText && (
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, margin: '8px 16px', textAlign: 'center' }}>
          {transcribedText}
        </div>
      )}
    </motion.div>
  )
}
```

---

## СТРУКТУРА ФАЙЛОВ СТАДИИ

```
src/core/voice/
  WakeWordDetector.ts     ← новый
  AudioCapture.ts         ← новый
  VoiceSession.ts         ← новый
  EmotionDetector.ts      ← новый
src/core/ai/
  STTService.ts           ← новый
  TTSService.ts           ← новый
src/main/
  windows/
    VoiceWindow.ts        ← обновить
  ipc/
    voice.ipc.ts          ← новый
src/renderer/
  pages/Voice/
    VoiceOverlayPage.tsx  ← новый
  components/voice/
    VoiceWave/            ← новый
    SpeakingWave/         ← новый
    VoiceStatus/          ← новый
assets/models/
  vosk-model-small-ru/    ← скачать вручную
```

---

## ПРОВЕРКА ГОТОВНОСТИ СТАДИИ

- [ ] Vosk модель загружена и работает офлайн
- [ ] Wake word "Синти" срабатывает надёжно
- [ ] После wake word: TTS говорит "Слушаю"
- [ ] Голосовой оверлей появляется в правом нижнем углу
- [ ] Пульсирующая волна при прослушивании
- [ ] Звуковая волна при ответе
- [ ] STT корректно транскрибирует русскую речь
- [ ] TTS озвучивает ответ
- [ ] В голосовом режиме скриншот обновляется каждые 5 сек
- [ ] "Стоп" во время работы агента останавливает его
- [ ] Ctrl+Shift+V toggle голосового режима
- [ ] В чате TTS только по кнопке (не автоматически)
- [ ] Иконка в трее анимируется при прослушивании
