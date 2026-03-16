/**
 * OpenCode Session Logger Plugin
 *
 * Logs completed blocks (thinking, tool calls, user messages, LLM text,
 * subtask spawns, step boundaries) to /tmp/opencode/session-<id>.jsonl
 *
 * Only logs when a block is DONE — no streaming deltas.
 */

import { mkdirSync, appendFileSync, existsSync } from "fs"
import { join } from "path"
import { execSync } from "child_process"
import type { Plugin } from "@opencode-ai/plugin"

const LOG_DIR = "/tmp/opencode"

type Event = {
  type: string
  properties: Record<string, any>
}

type Part = {
  id: string
  sessionID: string
  messageID: string
  type: string
  [key: string]: any
}

type Message = {
  id: string
  sessionID: string
  role: string
  [key: string]: any
}

// Track which parts/messages we've already logged to avoid duplicates
// (message.part.updated fires many times during streaming)
const loggedParts = new Set<string>()
const loggedMessages = new Set<string>()

function ensureDir() {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
  } catch {}
}

function logFile(sessionID: string): string {
  return join(LOG_DIR, `session-${sessionID}.jsonl`)
}

// Resolved once at plugin init
let _gitRemoteUrl: string | undefined

function resolveGitRemote(directory: string): string | undefined {
  try {
    // Check if .git exists
    if (!existsSync(join(directory, ".git"))) return undefined
    const url = execSync("git remote get-url origin", { cwd: directory, timeout: 3000 })
      .toString()
      .trim()
    return url || undefined
  } catch {
    return undefined
  }
}

function write(sessionID: string, entry: Record<string, any>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    sessionID,
    ...(_gitRemoteUrl && { gitRemote: _gitRemoteUrl }),
    ...entry,
  })
  try {
    appendFileSync(logFile(sessionID), line + "\n")
  } catch {
    // silently ignore write errors
  }
}

function isPartComplete(part: Part): boolean {
  switch (part.type) {
    case "text":
      // User text parts have no time field (immediate). Assistant text has time.start/end (streamed).
      // Complete when: no time field (user), or time.end is set (assistant finished streaming)
      return !part.time || !!part.time.end
    case "reasoning":
      // Reasoning is complete when it has time.end set
      return !!part.time?.end
    case "tool":
      // Tool is complete when state is "completed" or "error"
      return part.state?.status === "completed" || part.state?.status === "error"
    case "step-finish":
      // Step finish parts are always "complete" on creation
      return true
    case "step-start":
      return true
    case "subtask":
      // Subtask creation is a one-time event
      return true
    case "agent":
      return true
    case "retry":
      return true
    case "compaction":
      return true
    default:
      return false
  }
}

function formatPart(part: Part): Record<string, any> | null {
  switch (part.type) {
    case "text": {
      // User text parts have no time field; assistant text parts have time.start/end
      const isUserText = !part.time
      return {
        kind: isUserText ? "user-text" : "llm-text",
        partID: part.id,
        messageID: part.messageID,
        text: part.text,
        ...(part.synthetic && { synthetic: true }),
        ...(!isUserText && part.time?.end && part.time?.start && {
          duration: part.time.end - part.time.start,
        }),
      }
    }

    case "reasoning":
      return {
        kind: "thinking",
        partID: part.id,
        messageID: part.messageID,
        text: part.text,
        duration: part.time?.end && part.time?.start
          ? part.time.end - part.time.start
          : undefined,
      }

    case "tool": {
      const state = part.state
      if (state.status === "completed") {
        return {
          kind: "tool-call",
          partID: part.id,
          messageID: part.messageID,
          tool: part.tool,
          callID: part.callID,
          status: "completed",
          input: state.input,
          output: truncate(state.output, 2000),
          title: state.title,
          duration: state.time?.end && state.time?.start
            ? state.time.end - state.time.start
            : undefined,
        }
      }
      if (state.status === "error") {
        return {
          kind: "tool-call",
          partID: part.id,
          messageID: part.messageID,
          tool: part.tool,
          callID: part.callID,
          status: "error",
          input: state.input,
          error: state.error,
          duration: state.time?.end && state.time?.start
            ? state.time.end - state.time.start
            : undefined,
        }
      }
      return null
    }

    case "step-finish":
      return {
        kind: "step-finish",
        partID: part.id,
        messageID: part.messageID,
        reason: part.reason,
        cost: part.cost,
        tokens: part.tokens,
      }

    case "subtask":
      return {
        kind: "subtask",
        partID: part.id,
        messageID: part.messageID,
        agent: part.agent,
        description: part.description,
        prompt: truncate(part.prompt, 500),
      }

    case "agent":
      return {
        kind: "agent-switch",
        partID: part.id,
        messageID: part.messageID,
        agent: part.name,
      }

    case "retry":
      return {
        kind: "retry",
        partID: part.id,
        messageID: part.messageID,
        attempt: part.attempt,
        error: part.error,
      }

    default:
      return null
  }
}

function formatMessage(msg: Message): Record<string, any> | null {
  if (msg.role === "user") {
    return {
      kind: "user-message",
      messageID: msg.id,
      agent: msg.agent,
      model: msg.model,
      system: msg.system ? truncate(msg.system, 200) : undefined,
    }
  }

  if (msg.role === "assistant" && msg.time?.completed) {
    return {
      kind: "assistant-done",
      messageID: msg.id,
      parentID: msg.parentID,
      modelID: msg.modelID,
      providerID: msg.providerID,
      finish: msg.finish,
      cost: msg.cost,
      tokens: msg.tokens,
      error: msg.error,
    }
  }

  return null
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return s
  return s.length > max ? s.slice(0, max) + "..." : s
}

// ─── Plugin entry point ──────────────────────────────────────────────────────

const sessionLogger: Plugin = async (ctx) => {
  ensureDir()
  _gitRemoteUrl = resolveGitRemote(ctx.directory)

  return {
    event: async ({ event }) => {
      const e = event as Event

      // Log completed parts
      if (e.type === "message.part.updated") {
        const part = e.properties.part as Part
        if (!part?.sessionID) return

        // Only log when the part is actually complete
        if (!isPartComplete(part)) return

        // Deduplicate — we may see the same completed part multiple times
        const key = `${part.sessionID}:${part.id}:${part.type}`
        if (part.type === "tool") {
          // For tools, include status in key since we get updates at each status
          const toolKey = `${key}:${part.state?.status}`
          if (loggedParts.has(toolKey)) return
          loggedParts.add(toolKey)
        } else {
          if (loggedParts.has(key)) return
          loggedParts.add(key)
        }

        const entry = formatPart(part)
        if (entry) write(part.sessionID, entry)
      }

      // Log user messages (created) and assistant messages (completed)
      if (e.type === "message.updated") {
        const msg = e.properties.info as Message
        if (!msg?.sessionID) return

        if (msg.role === "user") {
          const key = `user:${msg.id}`
          if (loggedMessages.has(key)) return
          loggedMessages.add(key)
          const entry = formatMessage(msg)
          if (entry) write(msg.sessionID, entry)
        }

        if (msg.role === "assistant" && msg.time?.completed) {
          const key = `assistant-done:${msg.id}`
          if (loggedMessages.has(key)) return
          loggedMessages.add(key)
          const entry = formatMessage(msg)
          if (entry) write(msg.sessionID, entry)
        }
      }

      // Log session status changes
      if (e.type === "session.status") {
        const props = e.properties as { sessionID: string; status: any }
        if (props.sessionID) {
          write(props.sessionID, {
            kind: "session-status",
            status: props.status,
          })
        }
      }
    },
  }
}

export default sessionLogger
