# opencode-session-logger

An [OpenCode](https://opencode.ai) plugin that logs completed session blocks to JSONL files for observability and debugging.

## What it logs

Each completed block is written as a single JSON line to `/tmp/opencode/session-<id>.jsonl`:

| Kind | Description |
|------|-------------|
| `user-message` | User message metadata (agent, model) |
| `user-text` | User's actual text content |
| `llm-text` | Assistant text (with duration) |
| `thinking` | Reasoning/thinking blocks (with duration) |
| `tool-call` | Tool invocations — input, output, status, duration |
| `subtask` | Subtask/subagent spawns |
| `agent-switch` | Agent switches |
| `step-finish` | Step boundaries with token counts and cost |
| `assistant-done` | Assistant turn completion with total cost/tokens |
| `session-status` | Session status changes |
| `retry` | Retry attempts |

Every log line includes a timestamp, session ID, and git remote URL (if the project is a git repo).

Only completed blocks are logged — no streaming deltas.

## Install

Add the plugin to your `opencode.json`:

```json
{
  "plugin": ["github:utkarsh-611/opencode-session-logger"]
}
```

Or use a local file reference:

```json
{
  "plugin": ["file:///path/to/opencode-session-logger/src/index.ts"]
}
```

## Output

Logs are written to `/tmp/opencode/session-<session-id>.jsonl`. Each line is a JSON object:

```jsonl
{"ts":"2026-03-16T12:00:00.000Z","sessionID":"abc123","gitRemote":"git@github.com:user/repo.git","kind":"user-text","partID":"p1","messageID":"m1","text":"fix the bug in auth.ts"}
{"ts":"2026-03-16T12:00:01.000Z","sessionID":"abc123","gitRemote":"git@github.com:user/repo.git","kind":"thinking","partID":"p2","messageID":"m2","text":"Let me look at auth.ts...","duration":1500}
{"ts":"2026-03-16T12:00:03.000Z","sessionID":"abc123","gitRemote":"git@github.com:user/repo.git","kind":"tool-call","partID":"p3","messageID":"m2","tool":"read","status":"completed","input":{"path":"auth.ts"},"output":"...","duration":200}
```

View logs with:

```bash
# Pretty print all entries
jq . /tmp/opencode/session-*.jsonl

# Filter by kind
jq 'select(.kind == "tool-call")' /tmp/opencode/session-*.jsonl

# Show only tool calls with their durations
jq 'select(.kind == "tool-call") | {tool, status, duration}' /tmp/opencode/session-*.jsonl
```

## License

MIT
