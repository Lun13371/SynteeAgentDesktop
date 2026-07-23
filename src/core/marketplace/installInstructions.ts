/**
 * Генератор инструкций для агента — установка MCP-сервера или Skill
 * из маркетплейса. Инструкция отправляется как первое сообщение обычным
 * путём chat:create → chat:send (см. ScopeDialog.install в ExtensionsPopover.tsx);
 * агент выполняет её через свои стандартные инструменты (edit_file, write_file,
 * run_command).
 *
 * Scope:
 *   - 'global'          → агенту даются АБСОЛЮТНЫЕ пути (нет привязки к
 *                          проекту, workdir агента непредсказуем)
 *   - { workdir: string } → используются относительные пути (.mcp.json,
 *                          .syntee/skills/) — агент работает в этом workdir
 */

import { homedir } from 'os'
import { join } from 'path'
import type { MarketplaceMcpServer, MarketplaceSkill, McpPackageOption, McpRemoteOption } from '../../shared/types'

export type InstallScope = 'global' | { workdir: string }

function globalMcpPath(): string {
  return join(homedir(), '.syntee', 'mcp.json')
}

/** Формирует stdio-команду для npm/pypi пакета с учётом текущей ОС. */
function buildStdioCommand(pkg: McpPackageOption): { command: string; args: string[] } {
  const extraArgs = pkg.packageArguments ?? []
  if (pkg.registryType === 'npm') {
    if (process.platform === 'win32') {
      return { command: 'cmd', args: ['/c', 'npx', '-y', `${pkg.identifier}@${pkg.version}`, ...extraArgs] }
    }
    return { command: 'npx', args: ['-y', `${pkg.identifier}@${pkg.version}`, ...extraArgs] }
  }
  // pypi — предпочитаем uvx (runtimeHint), иначе python -m
  if (pkg.runtimeHint === 'uvx' || pkg.registryType === 'pypi') {
    return { command: 'uvx', args: [pkg.identifier, ...extraArgs] }
  }
  return { command: pkg.identifier, args: extraArgs }
}

/** Строит JSON-фрагмент mcpServers-записи для вставки в инструкцию. */
function buildMcpJsonEntry(
  serverKey: string,
  choice: { type: 'package'; package: McpPackageOption } | { type: 'remote'; remote: McpRemoteOption },
): string {
  if (choice.type === 'remote') {
    const entry: Record<string, unknown> = { url: choice.remote.url, type: choice.remote.type }
    const hasSecretHeaders = choice.remote.headers?.some(h => h.isSecret)
    if (hasSecretHeaders) {
      entry.headers = Object.fromEntries((choice.remote.headers ?? []).map(h => [h.name, h.value ?? `<${h.name}>`]))
    }
    return JSON.stringify({ mcpServers: { [serverKey]: entry } }, null, 2)
  }
  const { command, args } = buildStdioCommand(choice.package)
  const entry: Record<string, unknown> = { command, args }
  if (choice.package.environmentVariables?.length) {
    entry.env = Object.fromEntries(choice.package.environmentVariables.map(e => [e.name, `<${e.name}>`]))
  }
  return JSON.stringify({ mcpServers: { [serverKey]: entry } }, null, 2)
}

export interface McpInstallParams {
  server: MarketplaceMcpServer
  choice: { type: 'package'; package: McpPackageOption } | { type: 'remote'; remote: McpRemoteOption }
  scope: InstallScope
}

/** Генерирует текст инструкции для установки MCP-сервера. */
export function buildMcpInstallInstruction(params: McpInstallParams): string {
  const { server, choice, scope } = params
  const serverKey = server.title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || server.id
  const targetPath = scope === 'global' ? globalMcpPath() : join(scope.workdir, '.mcp.json')
  const jsonFragment = buildMcpJsonEntry(serverKey, choice)

  const envVars = choice.type === 'package' ? choice.package.environmentVariables : undefined
  const headers = choice.type === 'remote' ? choice.remote.headers : undefined
  const requiredSecrets = [
    ...(envVars ?? []).filter(v => v.isRequired || v.isSecret).map(v => `${v.name} — ${v.description}`),
    ...(headers ?? []).filter(h => h.isRequired || h.isSecret).map(h => `${h.name} (заголовок) — ${h.description}`),
  ]

  const lines: string[] = []
  lines.push(`Установи MCP-сервер "${server.title}" (${scope === 'global' ? 'глобально' : 'в этот проект'}).`)
  lines.push('')
  lines.push(server.description ? `Описание: ${server.description}` : '')
  lines.push('')
  if (requiredSecrets.length > 0) {
    lines.push('ПЕРЕД установкой спроси у меня значения для следующих переменных (не придумывай их сам):')
    for (const s of requiredSecrets) lines.push(`  - ${s}`)
    lines.push('')
  }
  lines.push(`Добавь в файл ${targetPath} следующую запись (создай файл/директорию, если их нет; если файл уже существует — не удаляй существующие серверы, только добавь новый):`)
  lines.push('')
  lines.push('```json')
  lines.push(jsonFragment)
  lines.push('```')
  lines.push('')
  lines.push(`Используй инструмент edit_file (с create_if_not_exists: true) или write_file для модификации ${targetPath}.`)
  if (choice.type === 'package' && choice.package.registryType === 'pypi') {
    lines.push('Пакет запускается через uvx — убедись, что он установлен (uv/uvx), либо предупреди меня если нет.')
  }
  lines.push('После добавления сообщи мне, что сервер установлен и как называется (ключ в mcpServers).')
  return lines.filter((_, i, arr) => !(arr[i] === '' && arr[i - 1] === '')).join('\n')
}

export interface SkillInstallParams {
  skill: MarketplaceSkill
  scope: InstallScope
}

/** Генерирует текст инструкции для установки Skill (клонирование репо + копирование .md). */
export function buildSkillInstallInstruction(params: SkillInstallParams): string {
  const { skill, scope } = params
  const targetDir = scope === 'global'
    ? '{АБСОЛЮТНЫЙ_ПУТЬ_К_ГЛОБАЛЬНЫМ_SKILLS}' // подставляется вызывающей стороной через IPC (main знает app.getPath('userData'))
    : '.syntee/skills'
  const tmpDirName = `.tmp-skill-${skill.name.replace(/[^a-zA-Z0-9-]/g, '-')}`

  const lines: string[] = []
  lines.push(`Установи скилы из репозитория ${skill.htmlUrl} (${scope === 'global' ? 'глобально' : 'в этот проект'}).`)
  lines.push('')
  if (skill.description) lines.push(`Описание репозитория: ${skill.description}`)
  lines.push('')
  lines.push('Выполни по шагам:')
  lines.push(`1. Склонируй репозиторий во временную папку: run_command: git clone --depth 1 ${skill.htmlUrl} ${tmpDirName}`)
  lines.push('2. Найди все .md-файлы, которые начинаются с YAML frontmatter вида:')
  lines.push('   ---')
  lines.push('   name: ...')
  lines.push('   description: ...')
  lines.push('   ---')
  lines.push(`   (обычно лежат в подпапке skills/*/SKILL.md или просто *.md в корне/skills/)`)
  lines.push(`3. Скопируй каждый найденный .md-файл в папку ${targetDir}/ (создай директорию если её нет). Если имена файлов конфликтуют — переименуй с префиксом репозитория.`)
  lines.push(`4. Удали временную папку ${tmpDirName} (run_command: rm -rf ${tmpDirName} на Linux/Mac или Remove-Item -Recurse -Force ${tmpDirName} на Windows).`)
  lines.push('5. Сообщи мне сколько скиллов установлено и их названия.')
  return lines.join('\n')
}

/** Абсолютный путь к глобальной папке skills (для подстановки в инструкцию). Main-процесс передаёт userDataSkillsPath. */
export function finalizeSkillInstruction(instruction: string, globalSkillsPath: string): string {
  return instruction.replace('{АБСОЛЮТНЫЙ_ПУТЬ_К_ГЛОБАЛЬНЫМ_SKILLS}', globalSkillsPath)
}

// ── Установка MCP по произвольному URL через AI ──────────────────────────────

export type McpUrlInstallScope = 'global' | { workdir: string }

export interface McpUrlInstallParams {
  url: string
  scope: McpUrlInstallScope
}

/**
 * Генерирует инструкцию для AI — установить MCP-сервер по произвольному URL.
 * AI сам определяет тип ссылки (GitHub/GitLab/npm/pypi/git), клонирует/читает
 * репозиторий, определяет команду запуска, записывает в mcp.json и сообщает
 * какие env-переменные нужно заполнить.
 */
export function buildMcpUrlInstallInstruction(params: McpUrlInstallParams): string {
  const { url, scope } = params
  const isGlobal = scope === 'global'
  const targetPath = '{АБСОЛЮТНЫЙ_ПУТЬ_К_MCP_JSON}'

  const lines: string[] = []
  lines.push(`Установи MCP-сервер из URL: ${url}`)
  lines.push(`Область установки: ${isGlobal ? 'глобально (доступен во всех проектах)' : 'в текущий проект'}.`)
  lines.push('')
  lines.push('Порядок действий:')
  lines.push('1. Определи тип URL:')
  lines.push('   - GitHub/GitLab/Bitbucket репозиторий (содержит github.com / gitlab.com / bitbucket.org или заканчивается на .git)')
  lines.push('   - npm пакет (начинается с @ или содержит @scope/name)')
  lines.push('   - pypi пакет (просто имя пакета)')
  lines.push('   - Прямой git URL (https://*.git или git@...:...)')
  lines.push('   - URL удалённого MCP-сервера (http/https, не git)')
  lines.push('')
  lines.push('2. В зависимости от типа:')
  lines.push('   А) Если это git-репозиторий (GitHub/GitLab/прямой git URL):')
  lines.push(`      - Склонируй во временную папку: git clone --depth 1 ${url} .tmp-mcp-install`)
  lines.push('      - Прочитай README.md, package.json, pyproject.toml, Dockerfile, или конфиг MCP (.mcp.json / mcp.json в репо)')
  lines.push('      - Определи как запускается сервер:')
  lines.push('        * Если package.json с bin/main → npm пакет, запуск через npx -y <pkg-name> или node <entry>')
  lines.push('        * Если pyproject.toml → pypi пакет, запуск через uvx <pkg-name> или python -m <module>')
  lines.push('        * Если Dockerfile → docker build + docker run -i --rm <image>')
  lines.push('        * Если в репо есть .mcp.json или mcp.json — прочитай его, там может быть готовая конфигурация')
  lines.push('      - Запомни определённые: command, args, env (из README/документации/примеров)')
  lines.push('      - Удали временную папку: rm -rf .tmp-mcp-install (или Remove-Item -Recurse -Force .tmp-mcp-install на Windows)')
  lines.push('')
  lines.push('   Б) Если это npm пакет (@scope/name или name):')
  lines.push('      - command: npx -y <pkg> (на Windows: cmd /c npx -y <pkg>)')
  lines.push('      - args: дополнительные аргументы если есть (из описания пакета)')
  lines.push('')
  lines.push('   В) Если это pypi пакет:')
  lines.push('      - command: uvx <pkg>')
  lines.push('      - Проверь что uvx доступен, если нет — предупреди')
  lines.push('')
  lines.push('   Г) Если это URL удалённого MCP (http/https, не git):')
  lines.push('      - Это remote сервер: { url: <URL>, type: "streamable-http" }')
  lines.push('      - Заголовки (headers) добавь если нужны для авторизации')
  lines.push('')
  lines.push('3. Запиши конфигурацию в файл ' + targetPath + ':')
  lines.push('   - Если файл уже существует — НЕ удаляй существующие серверы, добавь новый ключ')
  lines.push('   - Создай файл/директорию если их нет')
  lines.push('   - Формат записи (stdio):')
  lines.push('   ```json')
  lines.push('   {')
  lines.push('     "mcpServers": {')
  lines.push('       "<имя-сервера>": {')
  lines.push('         "command": "<команда>",')
  lines.push('         "args": ["арг1", "арг2"],')
  lines.push('         "env": { "KEY": "<значение>" }')
  lines.push('       }')
  lines.push('     }')
  lines.push('   }')
  lines.push('   ```')
  lines.push('   - Формат записи (remote):')
  lines.push('   ```json')
  lines.push('   {')
  lines.push('     "mcpServers": {')
  lines.push('       "<имя-сервера>": {')
  lines.push('         "url": "https://...",')
  lines.push('         "type": "streamable-http"')
  lines.push('       }')
  lines.push('     }')
  lines.push('   }')
  lines.push('   ```')
  lines.push('   - Используй edit_file (с create_if_not_exists: true) или write_file для записи')
  lines.push('')
  lines.push('4. Имя сервера (ключ в mcpServers) — выбери короткое понятное имя в snake-case или kebab-case')
  lines.push('')
  lines.push('5. Переменные окружения (env):')
  lines.push('   - Если сервер требует API ключи/токены/секреты — НЕ придумывай их значения')
  lines.push('   - В env укажи плейсхолдеры: "API_KEY": "<API_KEY>" (пустые или в угловых скобках)')
  lines.push('   - В отчёте пользователю укажи какие именно переменные нужно заполнить')
  lines.push('   - Скажи пользователю: "Заполните значения в Настройки → Расширения → MCP → [сервер] → Изменить env"')
  lines.push('')
  lines.push('6. Отчитайся:')
  lines.push('   - Что за сервер установлен (имя, тип запуска)')
  lines.push('   - Какие env-переменные нужно заполнить (если есть)')
  lines.push('   - Где искать настройки (Настройки → Расширения → MCP)')
  lines.push('   - Если были проблемы (нет npx/uvx/docker, не удалось клонировать) — сообщи')
  lines.push('')
  lines.push('ВАЖНО: Не запускай MCP-сервер вручную. Конфигурация в mcp.json достаточна — приложение само подключится.')
  return lines.join('\n')
}

/** Подставляет абсолютный путь к mcp.json в инструкцию. */
export function finalizeMcpUrlInstruction(instruction: string, mcpJsonPath: string): string {
  return instruction.replace('{АБСОЛЮТНЫЙ_ПУТЬ_К_MCP_JSON}', mcpJsonPath)
}
