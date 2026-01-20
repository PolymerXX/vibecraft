/**
 * Cross-platform Session Manager
 *
 * Replaces tmux with native Node.js child_process management.
 * Works on Windows, macOS, and Linux without external dependencies.
 */

import { spawn, ChildProcess } from 'child_process'
import { dirname } from 'path'
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { EOL } from 'os'

/** Session state */
export interface SessionState {
  id: string
  process: ChildProcess
  pid: number
  status: 'idle' | 'working' | 'offline'
  outputBuffer: string[]  // Ring buffer of output lines
  createdAt: number
  lastActivity: number
}

/** Session creation options */
export interface SessionOptions {
  id: string
  cwd: string
  claudeArgs?: string[]
  onOutput?: (line: string) => void
  onExit?: (code: number | null) => void
}

/** Permission prompt detection result */
export interface PermissionPrompt {
  tool: string
  context: string
  options: Array<{ number: string; label: string }>
}

const MAX_OUTPUT_LINES = 200  // Keep last 200 lines per session

/**
 * Session Manager - handles Claude Code processes without tmux
 */
export class SessionManager {
  private sessions = new Map<string, SessionState>()
  private logFile?: string

  constructor(logFile?: string) {
    this.logFile = logFile
    if (logFile) {
      const dir = dirname(logFile)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
    }
  }

  /**
   * Create and start a new Claude Code session
   */
  async create(options: SessionOptions): Promise<SessionState> {
    const { id, cwd, claudeArgs = [], onOutput, onExit } = options

    // Check if session already exists
    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists`)
    }

    this.log(`Creating session ${id} in ${cwd}`)

    // Build command
    const args = claudeArgs.length > 0 ? claudeArgs : [
      '-c',  // Continue mode
      '--permission-mode=bypassPermissions',
      '--dangerously-skip-permissions'
    ]

    // Spawn Claude Code process
    const childProcess = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows-specific: hide window
      windowsHide: true,
      // Set environment to include extended PATH
      env: {
        ...process.env,
        // Force color output even though not a TTY
        FORCE_COLOR: '1',
        // Disable Claude Code's own hooks to avoid recursion
        CLAUDE_HOOK_DISABLED: '1',
      }
    })

    if (!childProcess.pid) {
      throw new Error('Failed to spawn Claude Code process')
    }

    const state: SessionState = {
      id,
      process: childProcess,
      pid: childProcess.pid,
      status: 'idle',
      outputBuffer: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
    }

    this.sessions.set(id, state)

    // Capture stdout
    childProcess.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      this.appendOutput(state, text)
      onOutput?.(text)
    })

    // Capture stderr
    childProcess.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      this.appendOutput(state, text)
      onOutput?.(text)
    })

    // Handle process exit
    childProcess.on('exit', (code) => {
      this.log(`Session ${id} exited with code ${code}`)
      state.status = 'offline'
      onExit?.(code)
    })

    childProcess.on('error', (error) => {
      this.log(`Session ${id} error: ${error.message}`)
      state.status = 'offline'
    })

    this.log(`Session ${id} started (PID: ${childProcess.pid})`)
    return state
  }

  /**
   * Send text to a session (simulates typing)
   */
  async sendText(sessionId: string, text: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }

    if (state.status === 'offline' || !state.process.stdin) {
      throw new Error(`Session ${sessionId} is not running`)
    }

    this.log(`Sending text to session ${sessionId}: ${text.slice(0, 50)}...`)

    // Write text followed by newline
    state.process.stdin.write(text + '\n')
    state.lastActivity = Date.now()
  }

  /**
   * Send a control character (e.g., Ctrl+C)
   */
  async sendControl(sessionId: string, char: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }

    if (state.status === 'offline' || !state.process.stdin) {
      throw new Error(`Session ${sessionId} is not running`)
    }

    // Map control characters
    const controlMap: Record<string, string> = {
      'C-c': '\x03',  // Ctrl+C (SIGINT)
      'C-d': '\x04',  // Ctrl+D (EOF)
      'C-z': '\x1a',  // Ctrl+Z (SIGTSTP on Unix, not applicable on Windows)
    }

    const controlChar = controlMap[char]
    if (!controlChar) {
      throw new Error(`Unknown control character: ${char}`)
    }

    this.log(`Sending ${char} to session ${sessionId}`)
    state.process.stdin.write(controlChar)
    state.lastActivity = Date.now()
  }

  /**
   * Get recent output from a session
   */
  getOutput(sessionId: string, lines: number = 50): string {
    const state = this.sessions.get(sessionId)
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const recentLines = state.outputBuffer.slice(-lines)
    return recentLines.join('')
  }

  /**
   * Get all output from a session
   */
  getAllOutput(sessionId: string): string {
    const state = this.sessions.get(sessionId)
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }

    return state.outputBuffer.join('')
  }

  /**
   * Detect permission prompts in output
   */
  detectPermissionPrompt(sessionId: string): PermissionPrompt | null {
    const output = this.getOutput(sessionId, 50)
    return this.parsePermissionPrompt(output)
  }

  /**
   * Detect bypass permissions warning
   */
  detectBypassWarning(sessionId: string): boolean {
    const output = this.getOutput(sessionId, 50)
    return output.includes('WARNING') && output.includes('Bypass Permissions mode')
  }

  /**
   * Kill a session
   */
  async kill(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) {
      return  // Already gone
    }

    this.log(`Killing session ${sessionId} (PID: ${state.pid})`)

    // Close stdin to signal process to exit gracefully
    state.process.stdin?.end()

    // Give it 1 second to exit gracefully
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Force kill if still running
    if (!state.process.killed) {
      state.process.kill('SIGTERM')

      // Final SIGKILL after 2 more seconds
      await new Promise(resolve => setTimeout(resolve, 2000))
      if (!state.process.killed) {
        state.process.kill('SIGKILL')
      }
    }

    state.status = 'offline'
    this.sessions.delete(sessionId)
    this.log(`Session ${sessionId} killed`)
  }

  /**
   * List all sessions
   */
  list(): SessionState[] {
    return Array.from(this.sessions.values())
  }

  /**
   * Get a specific session
   */
  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Check if a session is alive
   */
  isAlive(sessionId: string): boolean {
    const state = this.sessions.get(sessionId)
    if (!state) return false

    // Check if process is still running
    if (state.process.killed || state.process.exitCode !== null) {
      state.status = 'offline'
      return false
    }

    return true
  }

  /**
   * Update session status
   */
  updateStatus(sessionId: string, status: 'idle' | 'working' | 'offline'): void {
    const state = this.sessions.get(sessionId)
    if (state) {
      state.status = status
      state.lastActivity = Date.now()
    }
  }

  /**
   * Clean up all sessions on shutdown
   */
  async shutdown(): Promise<void> {
    this.log('Shutting down all sessions...')
    const killPromises = Array.from(this.sessions.keys()).map(id => this.kill(id))
    await Promise.all(killPromises)
    this.log('All sessions terminated')
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private appendOutput(state: SessionState, text: string): void {
    // Split by lines but preserve structure
    const lines = text.split(/\r?\n/)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // If not the last line, add newline back
      const lineWithNewline = (i < lines.length - 1) ? line + EOL : line

      state.outputBuffer.push(lineWithNewline)
    }

    // Trim buffer to max size (ring buffer)
    if (state.outputBuffer.length > MAX_OUTPUT_LINES) {
      state.outputBuffer = state.outputBuffer.slice(-MAX_OUTPUT_LINES)
    }

    state.lastActivity = Date.now()
  }

  private parsePermissionPrompt(output: string): PermissionPrompt | null {
    const lines = output.split(/\r?\n/)

    // Look for "Do you want to proceed?" OR "Would you like to proceed?"
    let proceedLineIdx = -1
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
      if (/(Do you want|Would you like) to proceed\?/i.test(lines[i])) {
        proceedLineIdx = i
        break
      }
    }

    if (proceedLineIdx === -1) return null

    // Verify this is a real Claude Code prompt by checking for footer
    let hasFooter = false
    let hasSelector = false
    for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 15); i++) {
      if (/Esc to cancel|ctrl-g to edit/i.test(lines[i])) {
        hasFooter = true
        break
      }
      if (/^\s*❯/.test(lines[i])) {
        hasSelector = true
      }
    }

    if (!hasFooter && !hasSelector) return null

    // Parse numbered options
    const options: Array<{ number: string; label: string }> = []
    for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 10); i++) {
      const line = lines[i]
      if (/Esc to cancel/i.test(line)) break

      const optionMatch = line.match(/^\s*[❯>]?\s*(\d+)\.\s+(.+)$/)
      if (optionMatch) {
        options.push({
          number: optionMatch[1],
          label: optionMatch[2].trim()
        })
      }
    }

    if (options.length < 2) return null

    // Find tool name
    let tool = 'Unknown'
    for (let i = proceedLineIdx; i >= Math.max(0, proceedLineIdx - 20); i--) {
      const toolMatch = lines[i].match(/[●◐·]\s*(\w+)\s*\(/)
      if (toolMatch) {
        tool = toolMatch[1]
        break
      }
      const cmdMatch = lines[i].match(/^\s*(Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch)\s+\w+/i)
      if (cmdMatch) {
        tool = cmdMatch[1]
        break
      }
    }

    // Build context
    const contextStart = Math.max(0, proceedLineIdx - 10)
    const contextEnd = proceedLineIdx + 1 + options.length
    const context = lines.slice(contextStart, contextEnd).join('\n').trim()

    return { tool, context, options }
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] [SessionManager] ${message}`

    console.log(logMessage)

    if (this.logFile) {
      try {
        appendFileSync(this.logFile, logMessage + '\n')
      } catch {
        // Ignore log errors
      }
    }
  }
}
