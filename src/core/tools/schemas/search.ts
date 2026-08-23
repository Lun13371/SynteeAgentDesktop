// ── Search/web tool schemas ─────────────────────────────────────────────

export const SEARCH_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_code',
      description: 'Search code: regex or text in files via ripgrep. Smart-case by default (a lowercase pattern matches CamelCase; pass ignore_case=true to force insensitive, or use uppercase in the pattern for case-sensitive). path is OPTIONAL — defaults to the project root; pass a subfolder/file to narrow. Invalid regex is auto-retried as literal text (with a note). Respects .gitignore, searches hidden dot-directories (.vscode/.planning/...), excludes .git and secrets (.env/.pem/.key). Output legend: ">" marks a match line, "-" a context line, "..." a gap between separate matches; "(N matches, showing K)" means K of N matches in that file are displayed. If the header says "showing X of Y" — narrow file_glob/path or raise max_results; do NOT loop over pattern variants. For file NAMES use find_files; for "where is X / concepts" use get_fast_context.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or string. Example: "useState", "import.*axios", "class\\s+User". Special chars ( ) [ ] . $ are regex metachars — if you mean them literally, pass literal=true (or just pass them; an invalid regex is auto-searched literally).' },
          path: { type: 'string', description: 'Directory or file to search (absolute or relative to workdir). OPTIONAL — omit to search the whole project.' },
          file_glob: { type: 'string', description: 'File filter: "*.ts", "*.py", "*.{ts,tsx}"' },
          ignore_case: { type: 'boolean', description: 'Force case-insensitive. Default is smart-case (lowercase pattern = insensitive).' },
          literal: { type: 'boolean', description: 'Search pattern literally (no regex). Default false; auto-enabled if pattern is invalid regex.' },
          files_only: { type: 'boolean', description: 'Return only a list of matching files with per-file counts (no line content). Cheap broad overview before narrowing.' },
          max_results: { type: 'number', description: 'Max matches displayed (default 100). Per-file cap is ~10.' },
          max_chars: { type: 'number', description: 'Max chars in output (default 20000). Increase if truncated.' },
          context: { type: 'number', description: 'Context lines around a match (default 3).' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_web',
      description: 'Поиск в интернете через Tavily API. Используй для актуальной информации — новости, документация, ответы на вопросы.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Поисковый запрос' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fetch_page',
      description:
        'Скачать веб-страницу и получить её содержимое в чистом виде (markdown/текст, без HTML-мусора). Рендерит JavaScript (работает с SPA-сайтами, React/Angular/Vue). Используй ПОСЛЕ search_web для чтения найденных страниц, или сразу для любого URL. НЕ используй для API-эндпоинтов (JSON) — только для веб-страниц.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Полный URL страницы (https://...)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_images',
      description:
        'Поиск картинок в интернете по запросу. Возвращает URL изображений, тумбнейлы, размеры и страницы-источники. Используй когда нужны изображения: иллюстрации, скриншоты, фото, референсы. Запрос лучше на английском.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос (лучше на английском)' },
        },
        required: ['query'],
      },
    },
  },
] as const
