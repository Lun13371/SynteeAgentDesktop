/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- standalone Node regression runner */
// Run: node scripts/tool-image-regression.cjs (no live API requests or new dependencies).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')

function loadTS(relative, mocks = {}) {
  const filename = path.join(root, relative)
  const source = fs.readFileSync(filename, 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id]
    return require(require.resolve(id, { paths: [path.dirname(filename)] }))
  }
  vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, Buffer, console, setTimeout, clearTimeout, AbortController, DOMException, process, TextEncoder, TextDecoder, URL, URLSearchParams, queueMicrotask }, { filename })
  return module.exports
}
const plain = value => JSON.parse(JSON.stringify(value))
const toolImageMessages = loadTS('src/core/ai/toolImageMessages.ts')
const { routeToolImagesToUser } = toolImageMessages
const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=', detail: 'high' } }
const source = [
  { role: 'system', content: 'system' },
  { role: 'assistant', content: '', tool_calls: [
    { id: 'a', type: 'function', function: { name: 'analyze_image', arguments: '{}' } },
    { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
  ], reasoning_content: 'reason', thinking_blocks: [{ thinking: 'thought', signature: 'sig' }] },
  { role: 'tool', tool_call_id: 'a', name: 'analyze_image', content: [image, { type: 'text', text: 'question' }] },
  { role: 'tool', tool_call_id: 'b', name: 'read_file', content: 'file text' },
]
const before = JSON.stringify(source)
const routed = routeToolImagesToUser(source)
assert.deepEqual(plain(routed.map(m => m.role)), ['system', 'assistant', 'tool', 'tool', 'user'])
assert.equal(routed[2].content, 'question')
assert.equal(routed[3].content, 'file text')
assert.equal(routed[4].content[1].image_url.url, image.image_url.url)
assert.match(routed[4].content[0].text, /call_id: a/)
assert.equal(routed[1].reasoning_content, 'reason')
assert.equal(routed[1].thinking_blocks[0].signature, 'sig')
assert.equal(JSON.stringify(source), before, 'routing must not mutate canonical messages')
assert.equal(JSON.stringify(routeToolImagesToUser(routed)), JSON.stringify(routed), 'routing is idempotent')
const twoImages = routeToolImagesToUser([...source, { role: 'tool', tool_call_id: 'c', content: [image, { type: 'text', text: 'second' }] }])
assert.equal(twoImages.at(-1).content.filter(p => p.type === 'image_url').length, 2)
const multiRound = routeToolImagesToUser([...source, { role: 'assistant', content: 'followup' }, source[2], { role: 'user', content: 'next user' }])
assert.deepEqual(plain(multiRound.map(m => m.role)), ['system', 'assistant', 'tool', 'tool', 'user', 'assistant', 'tool', 'user', 'user'])
console.log('PASS Chat Completions: images routed after all parallel tool results, attribution, immutability, idempotency, multi-round')

const { convertMessagesToAnthropic } = loadTS('src/core/ai/anthropicConverters.ts', {
  '../prompts/buildSystemPrompt': { SYSTEM_PROMPT_CACHE_BREAK: '<break>' },
})
const anthropic = convertMessagesToAnthropic(source)
assert.equal(anthropic.messages[1].content[0].type, 'tool_result')
assert.equal(anthropic.messages[1].content[0].content[0].type, 'image')
assert.equal(anthropic.messages[1].content[0].content[0].source.data, 'aGVsbG8=')
assert.equal(anthropic.messages[1].content[1].tool_use_id, 'b')
console.log('PASS native Anthropic: pixels remain inside paired tool_result')

const mentions = loadTS('src/shared/mentions.ts')
const imageFormat = loadTS('src/shared/imageFormat.ts')
const {
  hydrateToolImageContent, hydrateHistoryContents, createImageHydrationBudget,
} = loadTS('src/core/ai/toolImageHistory.ts', {
  '../../shared/mentions': mentions,
  '../../shared/imageFormat': imageFormat,
})
const { messageToContextMessages } = loadTS('src/main/ipc/chatContextHelpers.ts', {
  '../../shared/attachmentMarkdown': { stripAttachTokens: text => text },
  // §steer — маркер внедрённой реплики (иначе require не найдёт shared/steer).
  '../../shared/steer': { STEER_MARKER: '[Пользователь написал во время твоей работы]' },
})
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-image-test-'))

async function main() {
  try {
    const file = path.join(tmp, 'test.png')
    fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=', 'base64'))
    const saved = {
      role: 'assistant', content: 'answer',
      toolSteps: [
        { type: 'tool_call', callId: 'a', toolName: 'analyze_image', toolArgs: { path: file }, content: '' },
        { type: 'tool_result', callId: 'a', toolName: 'analyze_image', content: 'Prepared image', imagePaths: [file], success: true },
      ],
    }
    const history = messageToContextMessages(JSON.parse(JSON.stringify(saved)))
    const tool = history.find(m => m.role === 'tool')
    assert.deepEqual(plain(tool.imagePaths), [file])
    const hydrated = hydrateToolImageContent(tool, true)
    assert.equal(hydrated[0].type, 'image_url')
    assert.equal(hydrated[0].image_url.url, `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`)
    assert.equal(hydrated.at(-1).text, 'Prepared image')
    assert.doesNotMatch(JSON.stringify(saved), /base64/)
    assert.match(hydrateToolImageContent(tool, false), /text-only model/)
    const missing = hydrateToolImageContent({ content: 'Prepared', imagePaths: [path.join(tmp, 'gone.png')] }, true)
    assert.equal(typeof missing, 'string')
    assert.match(missing, /No pixels were attached/)
    const mixed = hydrateToolImageContent({ content: 'Prepared', imagePaths: [file, path.join(tmp, 'gone.png')] }, true)
    assert.equal(mixed[0].type, 'image_url')
    assert.match(mixed.at(-1).text, /gone.png/)
    const svg = path.join(tmp, 'test.svg')
    fs.writeFileSync(svg, '<svg/>')
    assert.equal(typeof hydrateToolImageContent({ content: '', imagePaths: [svg] }, true), 'string')
    assert.equal(typeof hydrateToolImageContent({ content: '', imagePaths: ['relative.png'] }, true), 'string')
    const big = path.join(tmp, 'big.png')
    fs.writeFileSync(big, Buffer.alloc(20 * 1024 * 1024 + 1))
    assert.equal(typeof hydrateToolImageContent({ content: '', imagePaths: [big] }, true), 'string')
    delete saved.toolSteps[1].imagePaths
    saved.toolSteps[1].content = 'Изображение «old.png» приложено к этому результату.'
    const legacy = messageToContextMessages(saved).find(m => m.role === 'tool')
    assert.match(legacy.content, /image is NOT attached/)
    assert.equal(legacy.imagePaths, undefined)
    console.log('PASS history: JSON path persistence, exact pixels, missing/mixed/text-only/SVG/relative/oversize handling, legacy warning')

    // ── Budget: пиксели из истории переподставляются в КАЖДЫЙ запрос ──
    const noImages = createImageHydrationBudget({ maxImages: 0 })
    const omitted = hydrateToolImageContent({ content: 'Prepared', imagePaths: [file] }, true, noImages)
    assert.equal(typeof omitted, 'string')
    assert.match(omitted, /pixels omitted/)
    assert.doesNotMatch(omitted, /base64/)

    const tinyBudget = createImageHydrationBudget({ maxBytes: 4 })
    const omittedByBytes = hydrateToolImageContent({ content: 'Prepared', imagePaths: [file] }, true, tinyBudget)
    assert.equal(typeof omittedByBytes, 'string')
    assert.match(omittedByBytes, /exhausted/)

    // Правила провайдеров: большая картинка едет только в одиночку, иначе 400.
    const sideBudget = createImageHydrationBudget({ maxImages: 4 })
    const large = { base64Bytes: 1000, width: 4000, height: 3000 }
    const small = { base64Bytes: 1000, width: 800, height: 600 }
    assert.equal(sideBudget.reject(large), null)
    sideBudget.accept(large)
    assert.match(sideBudget.reject(small), /already carries a larger image/)
    const sideBudget2 = createImageHydrationBudget({ maxImages: 4 })
    assert.equal(sideBudget2.reject(small), null)
    sideBudget2.accept(small)
    assert.match(sideBudget2.reject(large), /cannot share a request/)
    assert.match(createImageHydrationBudget().reject({ base64Bytes: 10, width: 9000, height: 100 }), /limit 8000px/)

    const sharedBudget = createImageHydrationBudget({ maxImages: 1 })
    const newerImage = path.join(tmp, 'newer.png')
    fs.copyFileSync(file, newerImage)
    const historyContents = hydrateHistoryContents([
      { role: 'tool', content: 'older', imagePaths: [file] },
      { role: 'assistant', content: 'middle' },
      { role: 'tool', content: 'newer', imagePaths: [newerImage] },
    ], true, sharedBudget)
    assert.equal(typeof historyContents[0], 'string', 'oldest image must be dropped first')
    assert.match(historyContents[0], /pixels omitted/)
    assert.equal(historyContents[1], 'middle')
    assert.equal(Array.isArray(historyContents[2]), true, 'freshest image keeps its pixels')
    assert.equal(sharedBudget.images, 1)
    const deduped = hydrateToolImageContent({ content: 'again', imagePaths: [newerImage] }, true, sharedBudget)
    assert.match(deduped, /already attached in this request/)
    console.log('PASS image budget: fresh pixels win, oldest results degrade to text, duplicates and byte cap enforced')

    const catalog = { isCatalogReady: () => false }
    const vision = loadTS('src/core/ai/visionSupport.ts', { '../tokens/modelCatalog': catalog })
    const storeData = { modelAssignments: [
      { role: 'main', modelId: 'claude-sonnet-4-6', providerId: 'test' },
      { role: 'subagent', modelId: 'glm-5', providerId: 'test' },
    ] }
    const store = { get: (key, def) => storeData[key] ?? def }
    assert.equal(vision.agentModelSupportsVision(store, 'main'), true)
    assert.equal(vision.agentModelSupportsVision(store, 'subagent'), false)
    storeData.modelAssignments.pop()
    assert.equal(vision.agentModelSupportsVision(store, 'subagent'), true)
    storeData.subagentModel = 'qwen-vl'
    assert.equal(vision.agentModelSupportsVision(store, 'subagent'), true)
    console.log('PASS model routing: effective main/subagent assignment and fallback')

    const { analyzeImageFile } = loadTS('src/core/tools/image.ts', {
      openai: { default: class {} }, '../ai/AIClient': {}, '../ai/visionSupport': vision,
      '../../shared/constants': {}, '../../shared/mentions': mentions,
      '../../shared/imageFormat': imageFormat,
      './_shared': { resolveToolPath: (p, cwd) => path.resolve(cwd || root, p) },
    })
    const analyzed = await analyzeImageFile({ path: file, question: 'What is shown?' }, store)
    assert.equal(analyzed.success, true)
    assert.deepEqual(plain(analyzed.imagePaths), [file])
    assert.equal(analyzed.imageParts[0].type, 'image_url')
    assert.match(analyzed.output, /приложено для нативного визуального анализа/)
    assert.match(analyzed.output, /What is shown/)
    console.log('PASS analyze_image: real file -> visual result + saved absolute path + honest status')

    // ── Magic bytes: расширение ничего не доказывает ──
    const fakeImage = path.join(tmp, 'fake.png')
    fs.writeFileSync(fakeImage, Buffer.from('#!/bin/sh\necho "not an image"\n'))
    const fakeResult = await analyzeImageFile({ path: fakeImage }, store)
    assert.equal(fakeResult.success, false)
    assert.match(fakeResult.error, /not an image: its content is text/i)
    assert.equal(fakeResult.imageParts, undefined, 'no pixels for a text file named *.png')
    assert.doesNotMatch(fakeResult.error, /base64/)

    const binaryImage = path.join(tmp, 'binary.png')
    fs.writeFileSync(binaryImage, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]))
    const binaryResult = await analyzeImageFile({ path: binaryImage }, store)
    assert.equal(binaryResult.success, false)
    assert.match(binaryResult.error, /not a raster image/i)

    const svgImage = path.join(tmp, 'vector.svg')
    fs.writeFileSync(svgImage, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const svgResult = await analyzeImageFile({ path: svgImage }, store)
    assert.equal(svgResult.success, false)
    assert.match(svgResult.error, /convert to PNG first/)

    const hugeImage = path.join(tmp, 'huge.png')
    fs.writeFileSync(hugeImage, Buffer.alloc(imageFormat.MAX_IMAGE_FILE_BYTES + 1))
    const hugeResult = await analyzeImageFile({ path: hugeImage }, store)
    assert.equal(hugeResult.success, false)
    assert.match(hugeResult.error, /too large/i)
    assert.doesNotMatch(hugeResult.error, /base64/)
    console.log('PASS analyze_image guards: text/binary/SVG mislabeled as image and oversize files are refused, no base64 leak')

    // ── Формат по реальным байтам + реальные размеры в пикселях ──
    const pngSniff = imageFormat.sniffImage(fs.readFileSync(file))
    assert.equal(pngSniff.mime, 'image/png')
    assert.equal(pngSniff.supported, true)
    assert.equal(pngSniff.width, 1)
    assert.equal(pngSniff.height, 1)

    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0),
      0xff, 0xc0, 0x00, 0x11, 0x08,
      0x01, 0x2c,       // height 300
      0x01, 0x90,       // width 400
      ...Array(9).fill(0),
      0xff, 0xd9,
    ])
    const jpegSniff = imageFormat.sniffImage(jpeg)
    assert.equal(jpegSniff.mime, 'image/jpeg')
    assert.equal(jpegSniff.height, 300)
    assert.equal(jpegSniff.width, 400)

    const gifSniff = imageFormat.sniffImage(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xc8, 0x00, ...Array(20).fill(0)]))
    assert.equal(gifSniff.mime, 'image/gif')
    assert.equal(gifSniff.width, 320)
    assert.equal(gifSniff.height, 200)

    assert.equal(imageFormat.sniffImage(Buffer.from('hello, i am text')).mime, null)
    const bmpInfo = imageFormat.inspectImage(Buffer.concat([
      Buffer.from('BM'), Buffer.alloc(12), Buffer.from([0x28, 0, 0, 0]),
      Buffer.from([0x40, 0x06, 0, 0]), Buffer.from([0x40, 0x06, 0, 0]),
    ]))
    assert.equal(bmpInfo.mime, 'image/bmp')
    assert.equal(bmpInfo.supported, false, 'bmp is not accepted by vision APIs')
    assert.match(imageFormat.imageRejectionReason(bmpInfo), /convert it to PNG/)
    console.log('PASS imageFormat: magic bytes, PNG/JPEG/GIF pixel sizes, unsupported formats rejected before base64')

    // ── Нормализация (main-процесс): вместо отказа — уменьшение ──
    // Electron подменяем: проверяем решение "нужен ли ресайз" и ветку отказа,
    // не завися от реального nativeImage.
    let decodeCalls = 0
    const { normalizeImageForVision } = loadTS('src/main/services/imageDownscale.ts', {
      electron: { nativeImage: { createFromBuffer: () => { decodeCalls++; return { isEmpty: () => true } } } },
      '../../shared/imageFormat': imageFormat,
    })
    const smallPng = fs.readFileSync(file)
    const passthrough = normalizeImageForVision(smallPng)
    assert.equal(passthrough.ok, true)
    assert.equal(passthrough.image.downscaled, false)
    assert.equal(decodeCalls, 0, 'маленькая картинка не должна трогать декодер')
    const textFile = normalizeImageForVision(Buffer.from('just text'))
    assert.equal(textFile.ok, false)
    assert.match(textFile.error, /not an image/)
    const bigPng = Buffer.concat([smallPng, Buffer.alloc(imageFormat.MAX_IMAGE_FILE_BYTES)])
    const undecodable = normalizeImageForVision(bigPng)
    assert.equal(undecodable.ok, false)
    assert.equal(decodeCalls, 1, 'большая картинка идёт в ресайз')
    assert.match(undecodable.error, /Cannot decode/)
    console.log('PASS imageDownscale: small images pass through untouched, oversize goes to resize, junk is refused')

    let nativeCalled = false
    const { AIClient } = loadTS('src/core/ai/AIClient.ts', {
      openai: { default: class {} }, '@anthropic-ai/sdk': { default: class {} },
      '../../shared/reasoningModels': { responsesReasoningParam: () => ({}) },
      '../tokens/gatewayModelsCache': {}, '../tokens/modelCatalog': {},
      '../../shared/roundRobin': {}, '../../shared/constants': {},
      './anthropicConverters': { isAnthropicProvider: p => p.type === 'anthropic' },
      './shared': { DEFAULT_TEMPERATURE: 0, DEFAULT_MAX_TOKENS: 4096, OVERALL_TIMEOUT_MS: 10000, extractReasoningText: () => '', log: () => {} },
      './anthropicNative': { chatWithToolsAnthropic: async (_c, messages) => {
        nativeCalled = true
        assert.equal(messages[2].content[0].type, 'image_url')
        return { content: 'native' }
      } },
      './toolImageMessages': toolImageMessages, '../tokens/usageTracker': {},
      './toolCallHistory': { repairToolCallHistory: (messages) => messages },
      './mediaSupport': { resolveMediaTransport: () => 'unsupported', requestMediaAnalysis: async () => '' },
    })
    const ai = Object.create(AIClient.prototype)
    ai.store = { get: () => '' }
    ai.getModel = () => 'test-model'
    ai.getProviderInfoForRole = () => null
    ai.usesResponsesApi = () => false
    const fakeStream = async function* () { yield { choices: [{ delta: { content: 'ok' } }] } }
    let chatPayload
    ai.client = { chat: { completions: { create: async payload => { chatPayload = payload; return fakeStream() } } } }
    const chatResult = await ai.chatWithTools(source, [])
    assert.equal(chatResult.content, 'ok')
    assert.equal(typeof chatPayload.messages[2].content, 'string')
    assert.equal(chatPayload.messages.at(-1).content[1].type, 'image_url')
    assert.equal(JSON.stringify(source), before)
    let responsePayload
    const client = { responses: { create: async payload => { responsePayload = payload; return (async function* () {})() } } }
    await ai.chatWithToolsViaResponses(client, 'test', source, [], undefined, 4096, {}, {})
    const outputs = responsePayload.input.filter(i => i.type === 'function_call_output')
    assert.equal(outputs[0].output, 'question')
    assert.equal(outputs[1].output, 'file text')
    assert.doesNotMatch(JSON.stringify(outputs), /base64|image_url/)
    const visualInput = responsePayload.input.at(-1).content.find(p => p.type === 'input_image')
    assert.equal(visualInput.image_url, image.image_url.url)
    assert.equal(visualInput.detail, 'high')
    assert.equal(responsePayload.input[2].type, 'function_call_output')
    assert.equal(responsePayload.input[3].type, 'function_call_output')
    ai.getProviderInfoForRole = () => ({ provider: { type: 'anthropic' }, apiKey: 'fake' })
    ai.identityHeaders = () => ({})
    await ai.chatWithTools(source, [])
    assert.equal(nativeCalled, true)
    ai.getProviderInfoForRole = () => null
    ai.isOpencodeRole = () => false
    ai.client.chat.completions.create = async payload => {
      assert.equal(payload.messages.at(-1).content[1].type, 'image_url')
      throw Object.assign(new Error('Provider rejected visual input'), { status: 400 })
    }
    await assert.rejects(ai.chatWithTools(source, []), /Provider rejected visual input/)
    assert.equal(JSON.stringify(source), before, 'provider rejection must never remove canonical pixels')
    console.log('PASS actual AIClient request payloads: Chat Completions, Responses input_image (not JSON), native Anthropic branch, 400 preserves images')

    // ── Токены: пиксели должны быть видны оценке контекста ──
    // Раньше из multipart брались только text-парты, поэтому 30 МБ картинок
    // стоили «0 токенов»: контекст-бар молчал, клапан не срабатывал, а
    // провайдер отвечал 413.
    const usageTracker = loadTS('src/core/tokens/usageTracker.ts', {
      './modelCatalog': { getCatalogModel: () => null, isCatalogReady: () => false },
      './gatewayModelsCache': { getGatewayModelsCache: () => null, GATEWAY_PROVIDER_ID: 'syntee-gateway' },
      './ModelPricing': { getModelPrice: () => null },
      '../../shared/data/builtinModels': { BUILTIN_MODELS: [] },
      '../../shared/imageFormat': imageFormat,
    })
    const tokenImagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    const textOnlyTokens = usageTracker.estimateMessagesTokensFull([{ role: 'user', content: '' }])
    const imageTokens = usageTracker.estimateMessagesTokensFull([{ role: 'user', content: [tokenImagePart] }])
    assert.ok(imageTokens - textOnlyTokens >= imageFormat.IMAGE_TOKEN_COST,
      `image part must add ~${imageFormat.IMAGE_TOKEN_COST} tokens (got ${imageTokens - textOnlyTokens})`)

    // ── Клапан: пиксели снимаются раньше, чем удаляются раунды ──
    const { dropOldestRoundsIfOverflow, hasImagePayload, imagePayloadInfos } = loadTS('src/core/agent/utils.ts', {
      '../context/contextManager': { TOOL_SCHEMAS_OVERHEAD: 0 },
      '../tokens/usageTracker': { estimateMessagesTokensFull: usageTracker.estimateMessagesTokensFull },
      '../tools/schemas': { TOOL_SCHEMAS: [] },
      '../logger': { log: () => {} },
      '../../shared/imageFormat': imageFormat,
    })
    const toolMessages = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'analyze_image', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', name: 'analyze_image', content: [tokenImagePart, { type: 'text', text: 'receipt' }] },
      { role: 'user', content: 'next' },
    ]
    const canonicalBefore = JSON.stringify(toolMessages)
    assert.equal(dropOldestRoundsIfOverflow(toolMessages, 5000, 4000), toolMessages, 'under the limit the array is returned untouched')
    assert.equal(hasImagePayload(toolMessages[2].content), true)
    const compacted = dropOldestRoundsIfOverflow(toolMessages, 500, 100)
    assert.notEqual(compacted, toolMessages)
    assert.equal(compacted.length, toolMessages.length, 'rounds survive — only pixels are dropped')
    assert.equal(typeof compacted[2].content, 'string')
    assert.match(compacted[2].content, /receipt/)
    assert.match(compacted[2].content, /Image pixels were removed/)
    assert.equal(JSON.stringify(toolMessages), canonicalBefore, 'canonical messages must not be mutated')

    // Размеры берутся из самих байтов: по ним бюджет решает, можно ли
    // прикладывать картинку рядом с другими.
    const infos = imagePayloadInfos([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` } },
      { type: 'text', text: 'receipt' },
    ])
    assert.equal(infos.length, 2)
    assert.equal(infos[0].width, 1)
    assert.equal(infos[0].height, 1)
    assert.ok(infos[0].base64Bytes > 0)
    assert.equal(infos[1].base64Bytes, 0)
    console.log('PASS context accounting: image parts cost tokens; overflow valve drops pixels before whole rounds')

    console.log('All tool image regression checks passed.')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
