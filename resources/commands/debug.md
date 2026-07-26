---
name: debug
description: Систематичная отладка — гипотеза → проверка → вывод
icon: bug
argument-hint: описание бага или стектрейс
placeholder: опиши баг или вставь стектрейс...
mode: code
skill: debug-helper
---
Отлади проблему: $ARGS

Сформулируй 2-3 гипотезы о причине. Проверяй их по очереди через read_file/search_code/run_command. Локализуй root cause до конкретной строки. Предложи минимальный фикс и верифицируй его.
