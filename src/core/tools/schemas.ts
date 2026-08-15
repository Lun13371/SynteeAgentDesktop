import type { McpToolRuntime } from '../../shared/types'
import { isReadonlyPersona, getPersonaAllowedTools } from '../../shared/modes'

export const TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Edit a file. You MUST read the file with read_file before calling edit_file — the SEARCH block must match the actual file content. apply_patch — search/replace blocks (Codex-style, supports multiple edits, fuzzy matching and replace_all). insert — insert after a line. overwrite — replace the whole file. create_if_not_exists=true creates the file and directories. Returns a diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          mode: { type: 'string', enum: ['apply_patch', 'insert', 'overwrite'], description: 'Edit mode' },
          after_line: { type: 'number', description: '[insert] Insert after this line (1-indexed)' },
          content: { type: 'string', description: '[insert/overwrite] Content to insert or overwrite' },
          patch: { type: 'string', description: '[apply_patch] Search/replace patch. Format: blocks of <<<<<<< SEARCH / ======= / >>>>>>> REPLACE. Each block replaces one occurrence (or all if replace_all=true). Fuzzy-matches by ignoring leading whitespace. Example:\n<<<<<<< SEARCH\nold line\n=======\nnew line\n>>>>>>> REPLACE' },
          replace_all: { type: 'boolean', description: '[apply_patch] Replace ALL occurrences of each SEARCH block (default: false = first occurrence only)' },
          create_if_not_exists: { type: 'boolean', description: 'Создать файл (и директории) если не существует' },
          confirm_overwrite: { type: 'boolean', description: '[overwrite] Set to true to confirm a destructive overwrite (when >90% of lines are removed). Required when overwrite would drastically shrink the file.' },
        },
        required: ['path', 'mode'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Run a command in the terminal. Windows: PowerShell by default (ls/cat/rm/Get-Process/$env:PATH etc.), cmd — via shell:"cmd". Linux/Mac: bash. Specify cwd for projects, timeout for long operations.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command' },
          cwd: { type: 'string', description: 'Working directory' },
          shell: { type: 'string', enum: ['powershell', 'cmd'], description: 'Shell (Windows only, default powershell)' },
          timeout: { type: 'number', description: 'Timeout in seconds (default 60)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_diagnostics',
      description: 'Check the project for compilation and linting errors. Auto-detects the project language/stack (TypeScript, JavaScript, Python, Go, Rust, C#, Kotlin, Java, C/C++, Ruby, PHP, Lua, Swift, Dart, Elixir, Haskell, Scala, R, Nim, Zig, OCaml, Crystal, V, Clojure, Groovy, Perl, Objective-C, Erlang, Fortran, Julia, GraphQL, Protobuf, TOML, CMake, Bazel, JSON, YAML, Docker, Terraform, SQL, Markdown — 42 stacks total) and runs the appropriate type-checker and linter for each detected stack. Pass "files" to check ONLY specific files. Without "files", errors are sorted: changed files (git diff) first, then pre-existing. Call after code edits to verify nothing broke. Returns a list of errors with file:line.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project directory (defaults to the chat working directory)' },
          files: { type: 'array', items: { type: 'string' }, description: 'Specific files to check. If omitted, checks the whole project.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Читает файл. Без offset — первые 400 строк. С offset/limit — точный диапазон строк. Всегда показывает [total_lines] и подсказку с готовым offset если файл обрезан. Если повторно вызвать без offset на уже прочитанном файле — автоматически вернёт следующий непрочитанный чанк (auto-advance). Параметр full=true читает чанками по ~5000 символов — удобно для полного чтения больших файлов без ручного управления offset.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу (абсолютный или относительный от workdir)' },
          offset: { type: 'number', description: 'Начальная строка (1-indexed). Для чтения по частям.' },
          limit: { type: 'number', description: 'Кол-во строк (по умолч. 400). Увеличь до 500-800 если нужно больше за один вызов.' },
          full: { type: 'boolean', description: 'Read the entire file in chunks of ~5000 characters. Each repeated call without offset returns the next chunk automatically. Use for files you need to fully understand. Mutually exclusive with offset/limit.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'CREATE a new file from scratch. If the file already exists — use edit_file (mode=apply_patch/insert/overwrite) for edits, or pass force=true to overwrite (useful for restoring a corrupted file). Returns a diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          content: { type: 'string', description: 'File content' },
          force: { type: 'boolean', description: 'Overwrite existing file (default false). Use edit_file mode=overwrite as alternative.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'Show a folder contents as a tree. recursive=true traverses nested folders (depth default 3). Ignores node_modules/dist/.git.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the folder' },
          recursive: { type: 'boolean', description: 'Recursive traversal (default false)' },
          depth: { type: 'number', description: 'Recursion depth (default 3)' },
        },
        required: ['path'],
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
      name: 'http_request',
      description: 'Прямой HTTP-запрос к API или веб-странице. GET/POST/PUT/DELETE/PATCH с заголовками и телом. Возвращает status, headers, body. Быстрее и надёжнее чем curl через run_command — нет проблем с экранированием. Используй для: API-вызовы, вебхуки, скачивание JSON/XML, проверка эндпоинтов. ВАЖНО: success=true означает что запрос выполнился, а не что HTTP-статус успешный — всегда проверяй Status в выводе (404/500 тоже success=true).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Полный URL (http:// или https://)' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], description: 'HTTP-метод (по умолч. GET)' },
          headers: { type: 'object', description: 'Заголовки запроса. Например: {"Authorization": "Bearer ...", "Content-Type": "application/json"}', additionalProperties: { type: 'string' } },
          body: { type: 'string', description: 'Тело запроса (для POST/PUT/PATCH). JSON-строка, XML, plain text — что угодно.' },
          timeout: { type: 'number', description: 'Таймаут в секундах (по умолч. 30)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_system_info',
      description: 'Получить информацию о системе (OS, память, uptime).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generate_image',
      description: 'Сгенерировать изображение по текстовому описанию. Используй когда пользователь просит нарисовать, создать или сгенерировать изображение/картинку.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Детальное описание изображения на английском языке для лучшего качества' },
          model: { type: 'string', description: 'Модель генерации (опционально). Например: dall-e-3, dall-e-2, gpt-image-1' },
          size: { type: 'string', description: 'Размер изображения (опционально). Например: 1024x1024, 1792x1024, 1024x1792' },
          quality: { type: 'string', description: 'Качество: standard, hd (dall-e-3) или low, medium, high (gpt-image-1)' },
          style: { type: 'string', description: 'Стиль (только dall-e-3): vivid или natural' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_files',
      description: 'Read multiple files at once (up to 10). Each file is truncated to 250 lines; to read a large file fully use read_file with offset/limit. Use this instead of read_file when you need to look at several files of the project at once.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of absolute paths to files (up to 10)',
          },
        },
        required: ['paths'],
      },
    },
  },
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
      name: 'analyze_project',
      description: 'Full project analysis — file structure, dependencies, git status, statistics. Call at the start of working with an unfamiliar project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_fast_context',
      description: 'Fast project context: finds relevant files and line ranges by query via tree-sitter symbol index + fast LLM. Use as the FIRST step for any code task to instantly understand which files/functions/classes relate to the query — saves the main model tokens on search. Covers 80% of "where is X implemented" cases in ~1-3s. Result: a list of files with line ranges and a brief summary. Does not replace read_file for details — use it after to read the found files.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to find: a feature, function/class name, file, concept. Example: "where is the OAuth flow implemented", "User data model", "payment processing"' },
          maxFiles: { type: 'number', description: 'Max files to return (default 50)' },
          maxTokens: { type: 'number', description: 'Repo-map slice token budget (default 8000)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_files',
      description: 'Find files by name or regex pattern. Use when you need to find a file by name: "where is ChatPage.tsx?", "find all *.config.ts". Ignores node_modules/dist/.git.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'File name, glob (*.tsx) or regex. Example: "ChatPage.tsx", "*.config.ts", "index\\.(ts|tsx)"' },
          path: { type: 'string', description: 'Directory to search in' },
          max_results: { type: 'number', description: 'Max results (default 50)' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'spawn_agent',
      description: 'Launch a sub-agent for a subtask with a clean context. Blocks the turn until completion, returns a summary (what was done, changed files, diffs, executed commands — up to 4000 chars). The sub-agent ALREADY gets your context (chat summary + working memory + last 12 history messages) — do NOT duplicate it in the task. Use for: independent subtasks (parallel research A and B), long tasks polluting your context, delegating large Todo-plan items. Do NOT use for sequential steps or trivial 1-2 tool tasks (overhead). The task must be self-contained: what to do, file paths, constraints, what to return. Up to 3 agents in parallel, then a queue. Do not call get_agent_status in a loop — spawn_agent returns the result itself. By default (isolation=auto) the sub-agent writes to the parent workdir if there are no parallel sub-agents on this project; if there are, it automatically creates a separate git worktree (isolated copy from HEAD) and the delta is merged back after completion.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'A detailed description of the task for the sub-agent' },
          approval_mode: { type: 'string', enum: ['auto', 'ask', 'full'], description: 'Sub-agent approval mode (default: inherited from parent). full — no confirmations, ask — per tool, auto — smart detection' },
          isolation: { type: 'string', enum: ['auto', 'worktree', 'none'], description: 'Sub-agent file isolation. auto (default) — worktree only if there is a parallel sub-agent on this workdir, otherwise shared (sees parent WIP); worktree — always a separate git worktree from HEAD (for independent tasks: the sub-agent does not see the parent uncommitted edits, the delta is merged via git apply --3way); none — explicitly write to the parent workdir (only for dependent/read-only tasks). Non-git workdir always falls back to shared.' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_agent_status',
      description: 'Check the status of a sub-agent — whether it is active, what it is doing now, how many steps it has done. Use rarely — spawn_agent waits for completion itself. Useful only for UI or to check the progress of an already-finished agent.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Sub-agent ID from the [AGENT:id] marker' },
        },
        required: ['agent_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'think',
      description: 'Internal monologue — use BEFORE complex actions. Write a plan: what needs to be done, in what order, which files to read, what risks. The result is not visible to the user — only to you. Does not spend their tokens.',
      parameters: {
        type: 'object',
        properties: {
          thought: {
            type: 'string',
            description: 'Your reasoning, action plan, situation analysis.',
          },
        },
        required: ['thought'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_todo',
      description: 'Update the task checklist (todo list). Use for multi-step tasks — the user sees progress in the chat. Call at the start (with the plan) and after each completed step.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'List of steps. Each step: { text, status }.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Step description' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'skipped'], description: 'Step status' },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_working_memory',
      description: 'Update the chat working memory — notes about the project, edits made, current state. Call at the end of a session to remember what matters for the next messages. Max ~2000 tokens.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'New working memory content. Fully replaces the old one. Write compactly: what was done, current state, important facts about the project.',
          },
          mode: {
            type: 'string',
            enum: ['replace', 'append'],
            description: 'replace — full replacement (default), append — add to existing.',
          },
        },
        required: ['content'],
      },
    },
  },
  // ── save_memory: save a fact to long-term memory ──
  // Persistent memory across all sessions (unlike update_working_memory,
  // which lives only within one chat). Scope auto: 'project' if project_id
  // exists, otherwise 'global'. Dedup by key → update; cosine>0.92 → merge.
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save a fact to long-term memory (survives sessions). Use when you learned something important: user preferences, a project architectural decision, a learned lesson. Unlike update_working_memory (this chat only), save_memory is available across sessions. Scope auto: project if projectId exists, otherwise global. Dedup by key or semantic similarity.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short entry name (1-5 words, required). Will be shown as a heading. E.g. "Auth architecture", "Language preferences", "Outcome: FTS5 migration".',
          },
          content: {
            type: 'string',
            description: 'Detailed description. Can be long, with details, lists, files. Markdown is supported. E.g. "Decided to use JWT + refresh tokens.\\n- Access token: 15min\\n- Refresh token: 7days\\n- Stored in httpOnly cookies".',
          },
          kind: {
            type: 'string',
            enum: ['user_fact', 'project_decision', 'convention', 'conversation', 'agent_outcome'],
            description: 'user_fact — about the user (personal, preferences); project_decision — project architectural decision; convention — gotchas/traps/non-obvious project rules; conversation — dialog outcome; agent_outcome — lesson from an action outcome.',
          },
          key: {
            type: 'string',
            description: 'Dedup key (optional). If an entry with the same key exists — it will be updated. E.g. "name", "preferred_stack", "auth_approach".',
          },
          category: {
            type: 'string',
            description: '[user_fact] Subcategory: personal/work/preferences/projects/facts.',
          },
          scope: {
            type: 'string',
            enum: ['global', 'project'],
            description: 'global — memory across all projects; project — bound to the current project. Default: project if projectId exists, otherwise global.',
          },
          importance: {
            type: 'number',
            description: 'Importance 0..1 (default 0.5). Higher = ranks higher, lives longer. 1.0 for critical facts.',
          },
        },
        required: ['title', 'content', 'kind'],
      },
    },
  },
  // ── manage_notes: project and chat notes ──
  // Notes are short persistent records: project notes are visible across
  // all chats of the project (and in the system prompt), chat notes are
  // scoped to the current chat only. Use sparingly — max 15 project notes.
  {
    type: 'function',
    function: {
      name: 'manage_notes',
      description: 'Manage notes for the project or chat. Actions: create, update, delete, list. Project notes are visible in all chats of the project (shown in system prompt). Chat notes are specific to the current chat. Use for remembering important project facts, decisions, or context that should persist across sessions. Max 15 project notes — use sparingly, only for important information.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'delete', 'list'],
            description: 'What to do: create a new note, update an existing one, delete one, or list all notes.',
          },
          scope: {
            type: 'string',
            enum: ['project', 'chat'],
            description: 'project — note visible in all chats of this project; chat — note only for the current chat.',
          },
          title: {
            type: 'string',
            description: '[create/update] Note title (1-100 chars). Required for create, optional for update.',
          },
          content: {
            type: 'string',
            description: '[create/update] Note body text. Markdown supported. Optional for update (omit to keep existing).',
          },
          note_id: {
            type: 'string',
            description: '[update/delete] ID of the note to update or delete.',
          },
        },
        required: ['action', 'scope'],
      },
    },
  },
  // ── recall_memory: find relevant memories ──
  // Multi-source search: 5 sources in parallel (memory + messages + summaries + agent_logs + pinned).
  // FTS5 trigram for messages/pinned, TF-IDF for memory_items, LIKE for summaries/agent_logs.
  // Returns top-15 (3 per source), sorted by normalized score.
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: 'Find relevant memories and past context. Searches 5 sources IN PARALLEL: (1) long-term memory — facts/decisions/conventions/dialog outcomes, (2) messages of all chats in scope (FTS5 trigram), (3) chat summaries (compact outcomes of long dialogs), (4) agent action logs — which tools were called, errors, (5) pinned messages. Scope: if in a project — searches this project chats; if not — chats without a project. Global memory is ALWAYS in the search. Returns top-20 results with score and source, grouped by source.\n\nWHEN TO USE: start of a new task (especially in a project), "do you remember?", "how we did", "what we decided on X", unfamiliar project/file, a past decision/error mentioned, before an architectural decision.\n\nHOW TO WRITE THE QUERY: use keywords, not full sentences. Good: "JWT authorization", "TypeScript preferences", "ESLint error", "why Postgres". Bad: "tell me everything you know about the project".',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query — keywords or a phrase. E.g. "JWT authorization", "language preferences", "why we chose Postgres", "ESLint timeout error". Long queries are auto-split into keywords.',
          },
          kind: {
            type: 'string',
            enum: ['user_fact', 'project_decision', 'convention', 'conversation', 'agent_outcome'],
            description: 'Filter by memory type (optional). Without a filter — searches all types. Applies only to the "memory" source.',
          },
          scope: {
            type: 'string',
            enum: ['global', 'project', 'all'],
            description: 'Where to search in memory_items: global — only global; project — only current project; all — both (default). Does not affect chat sources.',
          },
          sources: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['memory', 'messages', 'summaries', 'agent_logs', 'pinned'],
            },
            description: 'Which sources to search (default: all 5). E.g. ["memory","messages"] — only memory and messages. Narrow if you know exactly what you need.',
          },
          limit: {
            type: 'number',
            description: 'How many entries to return (default 20, max 30). 5 per source if all 5 are enabled.',
          },
          crossProject: {
            type: 'boolean',
            description: 'If true, search across ALL projects (not just the current one). Default: false. Useful when the topic may span multiple projects.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_extensions',
      description: 'Show installed extensions: MCP servers (connection status, tool list) and all skills (name, description, active). Use when you need to know your capabilities.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  // ── get_skill: get a skill instructions by name ──
  {
    type: 'function',
    function: {
      name: 'get_skill',
      description: 'Get the full instructions of a skill by its name (from the list_extensions list). Returns the instruction text that must be followed in the work. Use when you see a needed skill in the list and want to apply its instructions.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name (exact match with the name from list_extensions)',
          },
        },
        required: ['name'],
      },
    },
  },
  // ── ask_user: ask the user clarifying questions ──
  // Available ALWAYS (not only in planning mode). The AI calls it when inputs
  // are insufficient for a quality answer — task scope, constraints, priorities,
  // choosing between alternatives. Round-trip via the UI panel above the input.
  {
    type: 'function' as const,
    function: {
      name: 'ask_user',
      description: 'Ask the user clarifying questions and get answers. Use when inputs are insufficient for a quality answer: unclear task scope, need constraints/priorities, choosing between alternatives. Supports different question types (text/choice/yesno), conditional logic (showIf), pre-fill. You can ask up to 5 questions — the user answers one by one (wizard). Do NOT overuse: if you can assume — do it, do not ask. After answers, continue work with the received info in mind.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'List of questions (1-5). The user answers one by one (wizard).',
            minItems: 1,
            maxItems: 5,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Question ID. Used for answer mapping and for showIf (conditions of other questions).' },
                question: { type: 'string', description: 'Question text for the user.' },
                header: { type: 'string', description: 'Short heading (optional).' },
                type: {
                  type: 'string',
                  enum: ['text', 'choice', 'yesno'],
                  description: 'Question type. text (default) — free answer. choice — choose from options (radio/checkbox). yesno — Yes/No buttons. If not specified, auto-detect: has options → choice, otherwise text.',
                },
                options: {
                  type: 'array',
                  description: 'Ready answer options (for type=choice).',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string', description: 'Option value (for mapping).' },
                      label: { type: 'string', description: 'Option display text.' },
                      description: { type: 'string', description: 'Option explanation (optional).' },
                    },
                    required: ['value', 'label'],
                  },
                },
                multiple: { type: 'boolean', description: 'Allow multi-select (only for type=choice).' },
                allowCustom: { type: 'boolean', description: 'Allow a custom answer (default true). Ignored for yesno.' },
                required: { type: 'boolean', description: 'Mandatory question (cannot skip).' },
                defaultValue: { type: 'string', description: 'Pre-filled answer — the model suggests an assumption, the user edits. Speeds up the answer.' },
                placeholder: { type: 'string', description: 'Custom placeholder for the text field (e.g. "port 3000").' },
                helpText: { type: 'string', description: 'Explanation under the question (collapsible block). For extra context.' },
                multiline: { type: 'boolean', description: 'Multi-line field 5+ lines (for descriptive answers).' },
                skipLabel: { type: 'string', description: 'Custom skip button text (default "Skip"). E.g. "I don\'t know", "You decide".' },
                showIf: {
                  type: 'object',
                  description: 'Show condition — the question is hidden until the answer to questionId equals equals. For branching: do not ask about CI if the answer to "need tests" = "no".',
                  properties: {
                    questionId: { type: 'string', description: 'ID of the question whose answer is checked.' },
                    equals: {
                      type: 'string',
                      description: 'Value at which this question is shown. For yesno — "true"/"false".',
                    },
                  },
                  required: ['questionId', 'equals'],
                },
              },
              required: ['question'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
  // ── get_graph: query the project knowledge graph ──
  // Returns file relationships (imports, calls), decision→file links,
  // concept connections. Text format for reading, mermaid for visualization.
  {
    type: 'function',
    function: {
      name: 'get_graph',
      description: 'Query the project knowledge graph — file relationships (who imports whom, who calls whom), decision→file links, concept connections. Use to understand project structure: which files are central hubs, what a decision affects, how files relate. Returns formatted text or mermaid diagram.',
      parameters: {
        type: 'object',
        properties: {
          nodeTypes: {
            type: 'array',
            items: { type: 'string', enum: ['decision', 'concept', 'file', 'symbol', 'conversation', 'task'] },
            description: 'Filter by node type (optional). E.g. ["file"] — only file nodes. ["decision","file"] — decisions and files. Default: all types.',
          },
          edgeTypes: {
            type: 'array',
            items: { type: 'string', enum: ['affects', 'mentions', 'implemented_in', 'depends_on', 'supersedes', 'references', 'imports', 'calls', 'implements'] },
            description: 'Filter by edge type (optional). E.g. ["imports"] — only import relationships. Default: all types.',
          },
          minWeight: {
            type: 'number',
            description: 'Minimum node weight (default 0). Higher = only well-connected nodes.',
          },
          limit: {
            type: 'number',
            description: 'Max nodes to return (default 100). Edges are filtered to only those between returned nodes.',
          },
          format: {
            type: 'string',
            enum: ['text', 'mermaid'],
            description: 'Output format. text — grouped list of nodes + edges (compact, for reading). mermaid — mermaid flowchart diagram (for visualization). Default: text.',
          },
        },
        required: [],
      },
    },
  },
]

// Dynamic tool set — added by mode
const TOOL_BY_NAME = new Map(
  TOOL_SCHEMAS.map(schema => [schema.function.name, schema]),
)

function pickTools(names: string[]) {
  return names
    .map(name => TOOL_BY_NAME.get(name))
    .filter((schema): schema is NonNullable<typeof schema> => schema !== undefined)
}

export function getToolSchemas(options: {
  planningMode?: boolean
  askMode?: boolean
  webMode?: boolean
  imageMode?: boolean
  multiAgentMode?: boolean
  mode?: 'code' | 'work'  // deprecated — ignored; work mode removed
  /** Persona — single-select run mode. Read-only personas get the same
   *  restricted tool set as planning/ask (no edit/write/run). Full personas
   *  keep the full toolset. Orthogonal to planning/ask. */
  persona?: import('../../shared/modes').PersonaId
  /** MCP tools — dynamically added to the set (only enabled ones). */
  mcpTools?: McpToolRuntime[]
} = {}) {
  const {
    planningMode = false,
    askMode = false,
    webMode = false,
    imageMode = false,
    multiAgentMode = false,
    persona,
    mcpTools,
  } = options

  // Work mode removed — always a full Code tool set.
  // In planning mode — read-only + research: all research tools are available
  // (get_fast_context, analyze_project, search_code, read_file, ...), the
  // ask_user clarifying-question tool, but edits are FORBIDDEN (edit/write/
  // run_command/revert). The planner researches code → clarifies with the
  // user → writes the plan directly in the answer, wrapped in
  // <plan title="..." summary="...">…</plan>.
  //
  // askMode (read-only) — the same read-only tool set as planning, but
  // without requiring a <plan>. Used for "do not touch code" questions
  // (toggled in the plus-menu or one-shot via /ask <text>).
  // planning takes priority (stricter), but the tool set is identical —
  // the difference is only in the system injection.
  //
  // Persona allowlist: when a persona defines `allowedTools`, that list
  // OVERRIDES the binary readonly/full branching below. Only the listed
  // builtin tools are provided (plus all MCP tools, always allowed).
  // This lets architect (edits, no run_command), debugger (full + run),
  // reviewer (strict read-only research), mentor (read-only + ask_user) get
  // a non-standard mix tailored to their workflow.
  const personaAllowed = persona ? getPersonaAllowedTools(persona) : undefined

  const names: string[] = [
    'read_file',
    'read_files',
    'find_files',
    'search_code',
    'list_directory',
    'think',
    'update_working_memory',
    'update_todo',
    'ask_user',
    // Long-term memory: save_memory (write a fact) + recall_memory (find).
    // Always available — the model decides when to save/recall.
    'save_memory',
    'recall_memory',
    // Knowledge graph: query project structure (file relationships, decisions).
    'get_graph',
    // Notes: manage project/chat notes (create/update/delete/list).
    'manage_notes',
    // Web search, HTTP and sub-agents — always available to the agent, the
    // model decides when to use them.
    'search_web',
    'http_request',
    'spawn_agent',
    'get_agent_status',
    'list_extensions',
    'get_skill',
  ]

  if (personaAllowed) {
    // Fine-grained persona allowlist: use ONLY the persona's list (intersected
    // with builtin TOOL_SCHEMAS). MCP tools are appended later regardless.
    // generate_image is gated by imageMode even if the persona lists it.
    names.length = 0
    for (const t of personaAllowed) {
      if (t === 'generate_image') continue
      names.push(t)
    }
    // Ensure research tools are available if the persona is read-only-ish
    // (allowlists already include them explicitly — this is a safety net).
    if (!names.includes('get_diagnostics') && isReadonlyPersona(persona!)) {
      names.push('get_diagnostics', 'analyze_project', 'get_fast_context')
    }
  } else if (planningMode || askMode || (persona && isReadonlyPersona(persona))) {
    // Planning / Ask / read-only persona (legacy path): research tools, read-only checks, no edits.
    names.push('get_diagnostics')
    names.push('analyze_project')
    names.push('get_fast_context')
  } else {
    // Normal mode (or full persona without explicit allowlist): file edits + commands + verification.
    names.push('edit_file')
    names.push('write_file')
    names.push('run_command')
    names.push('get_diagnostics')
    names.push('analyze_project')
    names.push('get_fast_context')
  }

  if (imageMode) {
    // generate_image only when imageMode is on AND the persona allows it
    // (allowlist personas that don't list it are denied; undefined/legacy
    // personas inherit the previous behavior — allowed in imageMode).
    if (!personaAllowed || personaAllowed.includes('generate_image')) {
      names.push('generate_image')
    }
  }
  // multiAgentMode/webMode are no longer needed for enabling — kept as
  // function parameters for compatibility with the calling code.
  void webMode
  void multiAgentMode

  const schemas = pickTools(names)

  // MCP tools — convert to OpenAI function schema and append.
  // Name: mcp__{serverName}__{toolName}, description from the MCP server.
  if (mcpTools && mcpTools.length > 0) {
    for (const tool of mcpTools) {
      schemas.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || `MCP tool ${tool.shortName} from server ${tool.serverName}`,
          parameters: tool.inputSchema && Object.keys(tool.inputSchema).length > 0
            ? tool.inputSchema
            : { type: 'object', properties: {} },
        },
      } as any)
    }
  }

  return schemas
}

// ── Side-chat-only tool ────────────────────────────────────────────────
// This tool is available ONLY in the parallel side chat. It is not
// included in TOOL_SCHEMAS and is not given to regular chats via getToolSchemas.
// Lets the side agent request the main chat messages on demand
// (instead of passing the whole history in context — saves tokens).
export const GET_MAIN_CHAT_MESSAGES_SCHEMA = {
  type: 'function',
  function: {
    name: 'get_main_chat_messages',
    description: 'Get messages from the main chat (parallel to this side chat). Returns message text with role indicated. Use to find information in the main chat history.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of recent messages (default 15, max 50).',
        },
        search: {
          type: 'string',
          description: 'Substring to filter messages (case-insensitive). If given, returns only messages containing this substring.',
        },
      },
    },
  },
} as const
