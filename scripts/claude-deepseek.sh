#!/bin/bash
# Запускает обычный Claude Code, но на DeepSeek (ключ берётся из настроек Orchestra, копий ключа нигде нет).
# Когда кончился лимит Claude, в той же папке проекта:  claude-deepseek.sh --continue
# Любые аргументы передаются в claude как есть (например --resume, -p "...").
CFG="${ORCHESTRA_CONFIG:-$HOME/Library/Application Support/Orchestra/config.json}"
KEY=$(python3 -c "import json,sys;print(next(p['token'] for p in json.load(open(sys.argv[1]))['providers'] if p['id']=='deepseek'))" "$CFG" 2>/dev/null)
[ -n "$KEY" ] || { echo "Не нашёл ключ DeepSeek в $CFG. Добавьте подключение DeepSeek в Orchestra."; exit 1; }

export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN="$KEY"
export ANTHROPIC_MODEL=deepseek-v4-pro ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# У DeepSeek окно 1M; без этого Claude Code считает 200K и сжимает беседу раньше времени.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
exec claude --model deepseek-v4-pro "$@"
