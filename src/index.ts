/**
 * OpenCode Session Logger Plugin
 *
 * Accumulates completed blocks (user message, thinking, LLM text, tool calls)
 * per turn — including subagent events. When the main agent's LLM stops
 * streaming, fires the full batch to localhost:4291.
 * Fire-and-forget — does not wait for a response.
 *
 * Requires a git repo with a remote — silently drops events if no repo URL.
 */

import { existsSync, appendFileSync } from "fs"
import { join } from "path"
import { execSync } from "child_process"
import type { Plugin } from "@opencode-ai/plugin"

const ENDPOINT = "http://localhost:4291"

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

// Deduplication
const loggedParts = new Set<string>()
const loggedMessages = new Set<string>()

// Single buffer — all events (main + subagent) accumulate here under the main session
let mainBuffer: Record<string, any>[] = []
let mainSessionID: string | undefined
let turnStartTime: string | undefined

// Track agents and models used in this turn
const agentsUsed = new Set<string>()
const modelsUsed = new Set<string>()

// Map subagent sessionID → parent sessionID
const childToParent = new Map<string, string>()

let _repoUrl: string | undefined
let _enabled = false

function resolveGitRemote(directory: string): string | undefined {
  try {
    if (!existsSync(join(directory, ".git"))) return undefined
    const url = execSync("git remote get-url origin", { cwd: directory, timeout: 3000 })
      .toString().trim()
    return url || undefined
  } catch { return undefined }
}

function resolveCommitId(directory: string): string | undefined {
  try {
    const hash = execSync("git rev-parse HEAD", { cwd: directory, timeout: 3000 })
      .toString().trim()
    return hash || undefined
  } catch { return undefined }
}

function accumulate(entry: Record<string, any>) {
  mainBuffer.push({ ts: new Date().toISOString(), ...entry })
}

function flushBuffer(directory: string) {
  if (!mainSessionID || mainBuffer.length === 0 || !_repoUrl) return
  const messages = mainBuffer
  const sessionID = mainSessionID
  const startTime = turnStartTime
  mainBuffer = []

  const commitId = resolveCommitId(directory)

  const payload: Record<string, any> = {
    sessionId: sessionID,
    repoUrl: _repoUrl,
    agentUsed: [...agentsUsed],
    modelUsed: [...modelsUsed],
    messages,
  }
  if (startTime) payload.startTime = startTime
  if (commitId) payload.commitId = commitId

  // Fire and forget
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {})

  agentsUsed.clear()
  modelsUsed.clear()
}

/** Resolve a sessionID to the root main session. */
function resolveMain(sessionID: string): string {
  let id = sessionID
  while (childToParent.has(id)) id = childToParent.get(id)!
  return id
}

/** Check if this sessionID belongs to the current main session tree. */
function isMainTree(sessionID: string): boolean {
  return mainSessionID !== undefined && resolveMain(sessionID) === mainSessionID
}

function isPartComplete(part: Part): boolean {
  switch (part.type) {
    case "text":
      return !part.time || !!part.time.end
    case "reasoning":
      return !!part.time?.end
    case "tool":
      return part.state?.status === "completed" || part.state?.status === "error"
    case "step-finish":
    case "step-start":
    case "subtask":
    case "agent":
    case "retry":
    case "compaction":
      return true
    default:
      return false
  }
}

function formatPart(part: Part): Record<string, any> | null {
  const isSubagent = part.sessionID !== mainSessionID

  switch (part.type) {
    case "text": {
      const isUserText = !part.time
      return {
        kind: isUserText ? "user-text" : "llm-text",
        ...(isSubagent && { subagent: true }),
        text: part.text,
        ...(!isUserText && part.time?.end && part.time?.start && {
          duration: part.time.end - part.time.start,
        }),
      }
    }
    case "reasoning":
      return {
        kind: "thinking",
        ...(isSubagent && { subagent: true }),
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
          ...(isSubagent && { subagent: true }),
          tool: part.tool,
          status: "completed",
          input: state.input,
          output: truncate(state.output, 2000),
          duration: state.time?.end && state.time?.start
            ? state.time.end - state.time.start
            : undefined,
        }
      }
      if (state.status === "error") {
        return {
          kind: "tool-call",
          ...(isSubagent && { subagent: true }),
          tool: part.tool,
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
    default:
      return null
  }
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return s
  return s.length > max ? s.slice(0, max) + "..." : s
}

// ─── Plugin entry point ──────────────────────────────────────────────────────

const sessionLogger: Plugin = async (ctx) => {
  _repoUrl = resolveGitRemote(ctx.directory)
  _enabled = !!_repoUrl

  return {
    event: async ({ event }) => {
      if (!_enabled) return

      const e = event as Event

      // Track session hierarchy from session.created
      if (e.type === "session.created") {
        const info = e.properties.info as { id: string; parentID?: string }
        if (info.parentID) {
          childToParent.set(info.id, info.parentID)
        }
      }

      // Completed parts → accumulate (main + subagent events into one buffer)
      if (e.type === "message.part.updated") {
        const part = e.properties.part as Part
        if (!part?.sessionID) return
        if (!isPartComplete(part)) return
        if (!isMainTree(part.sessionID)) return

        const key = `${part.sessionID}:${part.id}:${part.type}`
        if (part.type === "tool") {
          const toolKey = `${key}:${part.state?.status}`
          if (loggedParts.has(toolKey)) return
          loggedParts.add(toolKey)
        } else {
          if (loggedParts.has(key)) return
          loggedParts.add(key)
        }

        const entry = formatPart(part)
        if (entry) accumulate(entry)

        // Main session step-finish with stop/end_turn → flush everything
        if (
          part.type === "step-finish" &&
          part.sessionID === mainSessionID &&
          (part.reason === "stop" || part.reason === "end_turn")
        ) {
          flushBuffer(ctx.directory)
        }
      }

      // User message on main session → reset buffer for new turn
      if (e.type === "message.updated") {
        const msg = e.properties.info as Message
        if (!msg?.sessionID) return

        // Track agents and models (extract string model name only)
        if (msg.agent) agentsUsed.add(typeof msg.agent === "string" ? msg.agent : msg.agent.name ?? String(msg.agent))
        const modelName = msg.modelID ?? (typeof msg.model === "string" ? msg.model : msg.model?.modelID)
        if (modelName) modelsUsed.add(modelName)

        if (msg.role === "user" && !childToParent.has(msg.sessionID)) {
          const key = `user:${msg.id}`
          if (loggedMessages.has(key)) return
          loggedMessages.add(key)

          // Set/update main session
          mainSessionID = msg.sessionID
          mainBuffer = []
          turnStartTime = new Date().toISOString()
          accumulate({ kind: "user-message" })
        }
      }
    },
  }
}

export default sessionLogger
