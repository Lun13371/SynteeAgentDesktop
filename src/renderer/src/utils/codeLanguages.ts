// ── Регистрация языков подсветки ─────────────────────────────────────────
//
// ЕДИНЫЙ ИНСТАНС refractor. Раньше codeHighlightHTML импортировал
// 'refractor/core' сам, а codeLanguages регистрировал языки в СВОЁМ импорте
// того же пакета. Vite может разрешить один импорт как ESM, другой — как
// CJS-пре-бандл → два разных объекта: регистрация уходит в один, а
// highlight() читает другой. Результат: «Unknown language», catch отдаёт
// escapeHtml, и ВСЕ код-блоки (сообщения, карточки тулов) рендерятся без
// подсветки — 0 span.token, хотя языки «зарегистрированы».
// Теперь инстанс экспортируется отсюда, и все используют ТОЛЬКО его.

// refractor 5: именованный экспорт { refractor } (в v4 был default).
import { refractor } from 'refractor/core'

// Регистрируем только нужные языки (~28 вместо ~270 в полном Prism).
// refractor 5 (пришёл с react-syntax-highlighter 16) поменял exports-мап:
// './*' → './lang/*.js', поэтому языки импортируются как 'refractor/<lang>',
// а не 'refractor/lang/<lang>' (иначе путь резолвится в lang/lang/...).
import tsx from 'refractor/tsx'
import typescript from 'refractor/typescript'
import javascript from 'refractor/javascript'
import jsx from 'refractor/jsx'
import python from 'refractor/python'
import json from 'refractor/json'
import bash from 'refractor/bash'
import shell from 'refractor/shell-session'
import sql from 'refractor/sql'
import go from 'refractor/go'
import rust from 'refractor/rust'
import yaml from 'refractor/yaml'
import markdownLang from 'refractor/markdown'
import cssLang from 'refractor/css'
import markup from 'refractor/markup'
import java from 'refractor/java'
import cLang from 'refractor/c'
import cpp from 'refractor/cpp'
import csharp from 'refractor/csharp'
import php from 'refractor/php'
import ruby from 'refractor/ruby'
import diffLang from 'refractor/diff'
// Языки, нужные только карточкам тулов (getLanguage в ToolResultRenderer):
// раньше их регистрировал react-syntax-highlighter, теперь подсветка одна —
// через highlightCodeToHtml, поэтому регистрируем здесь.
import toml from 'refractor/toml'
import scss from 'refractor/scss'
import powershell from 'refractor/powershell'
import graphql from 'refractor/graphql'
import docker from 'refractor/docker'

const GRAMMARS = [
  tsx, typescript, javascript, jsx, python, json, bash, shell, sql, go, rust,
  yaml, markdownLang, cssLang, markup, java, cLang, cpp, csharp, php, ruby,
  diffLang, toml, scss, powershell, graphql, docker,
]

// Алиасы языков (как в react-syntax-highlighter registerLanguage)
const ALIASES: Array<[string, string[]]> = [
  ['typescript', ['ts']],
  ['javascript', ['js']],
  ['python', ['py']],
  ['bash', ['sh']],
  ['shell-session', ['shell', 'console']],
  ['rust', ['rs']],
  ['yaml', ['yml']],
  ['markdown', ['md']],
  ['markup', ['html', 'xml']],
  ['cpp', ['c++']],
  ['csharp', ['cs']],
  ['ruby', ['rb']],
]

let registered = false

/** Идемпотентная регистрация языков в ОБЩЕМ инстансе refractor. */
export function registerLanguages(): void {
  if (registered) return
  for (const grammar of GRAMMARS) {
    try { refractor.register(grammar) } catch { /* дубликат/несовместимая грамматика — не роняем остальные */ }
  }
  for (const [name, aliases] of ALIASES) {
    try { refractor.alias(name, aliases) } catch { /* алиас требует зарегистрированного языка */ }
  }
  // Флаг ставим только когда ВСЁ прошло: иначе одна упавшая грамматика
  // навсегда оставляла остальные незарегистрированными.
  registered = true
}

/** Зарегистрирован ли язык (с защитой от старой версии refractor). */
export function isLanguageRegistered(lang: string): boolean {
  registerLanguages()
  try {
    return typeof refractor.registered === 'function' ? refractor.registered(lang) : true
  } catch {
    return true
  }
}

export { refractor }
