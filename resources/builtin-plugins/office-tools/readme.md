# Office Tools — офисные документы

Встроенный плагин SynteeHelper: полный цикл работы с Word- и Excel-документами.

## Тулы (для AI)

| Тул | Что делает |
|---|---|
| `word_create` | Создание .docx из JSON-спеки: стили, списки, таблицы (merged/borders/fills), картинки, TOC, колонтитулы (default/first/even), сноски, водяные знаки, титульная страница, закладки/ссылки, настройка страницы, умная вёрстка |
| `word_spec_docs` | Полный справочник формата спеки (вызывай перед сложными документами) |
| `word_read` | Чтение .docx: `structure` / `text` / `full` (с сохранением page setup) / `stats`. Встроенные картинки извлекаются в файлы (`cache/media`) и возвращаются путями — base64 в контекст AI не попадает |
| `word_edit` | Гранулярные правки существующих .docx: append/insert_after/insert_at, replace_text, replace_block, move_block, delete_block, set_style, set_page, set_typography, add/remove_watermark, add_header/add_footer, remove_header/footer, insert_table, add_image, patch_document |
| `word_append` | Дописать блоки в конец документа |
| `word_compare` | Сравнение двух .docx (диф по блокам или строкам): добавлено/удалено/изменено |
| `excel_create` | Создание .xlsx из JSON-спеки: листы, формулы, форматы, стили, merged, freeze, автофильтры, валидация, условное форматирование, защита |
| `excel_spec_docs` | Справочник формата Excel-спеки |
| `excel_read` | Чтение .xlsx: `meta` / `values` / `formulas` / `full` (+ превью-таблица в чате) |
| `excel_edit` | Гранулярные правки: ячейки, строки/колонки, листы, ширины, merge, freeze, сортировка |
| `excel_chart` | Диаграммы через реальный Excel (COM) |
| `office_convert` | Конвертация: xlsx↔csv, docx→markdown/txt/html |
| `office_export_pdf` | Экспорт .docx/.xlsx → PDF (COM) |
| `office_open` | Открыть файл в реальном Word/Excel (COM) |

## Умная вёрстка Word (настраивается в панели + в спеке)

- **Поля по умолчанию**: ГОСТ (3/1.5/2/2 см) / Word (2.54 см) / свои значения. Спека `page.margins` всегда выигрывает.
- **Красная строка** 1.25 см для абзацев: авто (для русскоязычных текстов) / всегда / никогда (`page.firstLineIndent`).
- **Компактные отступы списков** (`page.compactLists`, по умолчанию вкл).
- **Умные разрывы страниц** (`page.smartBreaks`, по умолчанию вкл): заголовки не отрываются от текста (keepNext/keepLines), строки таблиц не рвутся между страницами (cantSplit, отключается `allowSplit: true` у таблицы).
- **Точный подсчёт страниц** — контент-ориентированная оценка (поля, шрифт, таблицы, картинки, разрывы).
- **Водяной знак** (`page.watermark`: text/color/opacity/diagonal) — VML-шейп в колонтитуле.
- **Колонтитулы first/even/odd** (`page.differentFirstPage`, `page.evenAndOdd` + `header: { default, first, even }`).
- При `word_edit` page setup (поля/размер/ориентация/колонки) сохраняется.

## Панель

Правая панель «Office»: быстрые действия (новый документ/таблица/из шаблона), недавние файлы, настройки (папка сохранения, превью, поля страницы, красная строка, списки, разрывы), живое превью текущего документа.

## Команда

`/office` — открыть панель.

## Рендеры в чате

- Карточка файла (после word_create) — имя, статистика, кнопки «Открыть» / «Показать в папке» / «PDF»
- Превью Excel-таблиц

## Технологии

- Генерация Word: npm `docx`; Excel: `exceljs`; чтение: `mammoth`; zip: `adm-zip` (ставятся автоматически в папку плагина)
- COM-автоматизация Word/Excel: PowerShell-скрипты (`process:exec`)
- Файлы по умолчанию: `Documents\Office Tools` (настраивается в панели)
