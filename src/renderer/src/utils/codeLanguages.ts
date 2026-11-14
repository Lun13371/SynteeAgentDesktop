// ── Регистрация языков подсветки ─────────────────────────────────────────
//
// Вынесено из MessageBubble.tsx: регистрация нужна любому markdown-рендеру
// (в т.ч. ленте хода работы), а сам highlightCodeToHtml лежит в
// utils/codeHighlightHTML. Импорт этого модуля — побочный эффект: он
// регистрирует языки в общем инстансе refractor.

// refractor 5: именованный экспорт { refractor } (в v4 был default).
import { refractor } from 'refractor/core'

// Регистрируем только нужные языки (~23 вместо ~270 в полном Prism).
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

refractor.register(tsx)
refractor.register(typescript)
refractor.register(javascript)
refractor.register(jsx)
refractor.register(python)
refractor.register(json)
refractor.register(bash)
refractor.register(shell)
refractor.register(sql)
refractor.register(go)
refractor.register(rust)
refractor.register(yaml)
refractor.register(markdownLang)
refractor.register(cssLang)
refractor.register(markup)
refractor.register(java)
refractor.register(cLang)
refractor.register(cpp)
refractor.register(csharp)
refractor.register(php)
refractor.register(ruby)
refractor.register(diffLang)

// Алиасы языков (как в react-syntax-highlighter registerLanguage)
refractor.alias('typescript', ['ts'])
refractor.alias('javascript', ['js'])
refractor.alias('python', ['py'])
refractor.alias('bash', ['sh'])
refractor.alias('shell-session', ['shell', 'console'])
refractor.alias('rust', ['rs'])
refractor.alias('yaml', ['yml'])
refractor.alias('markdown', ['md'])
refractor.alias('markup', ['html', 'xml'])
refractor.alias('cpp', ['c++'])
refractor.alias('csharp', ['cs'])
refractor.alias('ruby', ['rb'])
