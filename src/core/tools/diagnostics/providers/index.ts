// ── Реестр всех диагностических провайдеров ──
// Каждый провайдер определяет: detect(dir) — применим ли, run(dir, files?) — запускает проверку.
// Оркестратор (../index.ts) фильтрует провайдеры через detect() и запускает все применимые параллельно.

import type { DiagnosticProvider } from '../types'

// TypeScript / JavaScript
import { typescriptProvider } from './typescript'
import { eslintProvider } from './eslint'

// Python
import { pythonProvider } from './python'

// Go
import { goProvider } from './go'

// Rust
import { rustProvider } from './rust'

// C# / .NET
import { dotnetProvider } from './dotnet'

// Kotlin (перед Java — build.gradle.kts может быть и Kotlin, и Java)
import { kotlinProvider } from './kotlin'

// Java
import { javaProvider } from './java'

// C / C++
import { cppProvider } from './cpp'

// Ruby
import { rubyProvider } from './ruby'

// PHP
import { phpProvider } from './php'

// Lua
import { luaProvider } from './lua'

// Swift
import { swiftProvider } from './swift'

// Shell
import { shellProvider } from './shell'

// Dart / Flutter
import { dartProvider } from './dart'

// Elixir
import { elixirProvider } from './elixir'

// Haskell
import { haskellProvider } from './haskell'

// Scala
import { scalaProvider } from './scala'

// R
import { rProvider } from './r'

// Nim
import { nimProvider } from './nim'

// Zig
import { zigProvider } from './zig'

// OCaml
import { ocamlProvider } from './ocaml'

// Crystal
import { crystalProvider } from './crystal'

// V
import { vProvider } from './v'

// Clojure
import { clojureProvider } from './clojure'

// Groovy
import { groovyProvider } from './groovy'

// Perl
import { perlProvider } from './perl'

// Objective-C
import { objcProvider } from './objc'

// Erlang
import { erlangProvider } from './erlang'

// Fortran
import { fortranProvider } from './fortran'

// Julia
import { juliaProvider } from './julia'

// GraphQL
import { graphqlProvider } from './graphql'

// Protocol Buffers
import { protobufProvider } from './protobuf'

// TOML
import { tomlProvider } from './toml'

// CMake
import { cmakeProvider } from './cmake'

// Bazel
import { bazelProvider } from './bazel'

// JSON
import { jsonProvider } from './json'

// YAML
import { yamlProvider } from './yaml'

// Docker
import { dockerProvider } from './docker'

// Terraform
import { terraformProvider } from './terraform'

// SQL
import { sqlProvider } from './sql'

// Markdown
import { markdownProvider } from './markdown'

/**
 * Все зарегистрированные провайдеры диагностики (42 стека/языка).
 * Порядок: основные языки сначала, вспомогательные (конфиг-форматы) — в конце.
 * Kotlin перед Java — build.gradle.kts может быть и Kotlin-проектом.
 * Оркестратор запускает все detect() и выполняет только применимые.
 */
export const DIAGNOSTIC_PROVIDERS: DiagnosticProvider[] = [
  // Основные языки
  typescriptProvider,
  eslintProvider,
  pythonProvider,
  goProvider,
  rustProvider,
  dotnetProvider,
  kotlinProvider,
  javaProvider,
  cppProvider,
  rubyProvider,
  phpProvider,
  luaProvider,
  swiftProvider,
  shellProvider,
  dartProvider,
  elixirProvider,
  haskellProvider,
  scalaProvider,
  rProvider,
  nimProvider,
  zigProvider,
  ocamlProvider,
  crystalProvider,
  vProvider,
  clojureProvider,
  groovyProvider,
  perlProvider,
  objcProvider,
  erlangProvider,
  fortranProvider,
  juliaProvider,
  // Вспомогательные / конфиг-форматы
  graphqlProvider,
  protobufProvider,
  tomlProvider,
  cmakeProvider,
  bazelProvider,
  jsonProvider,
  yamlProvider,
  dockerProvider,
  terraformProvider,
  sqlProvider,
  markdownProvider,
]