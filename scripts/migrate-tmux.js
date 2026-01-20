#!/usr/bin/env node
/**
 * Automated migration script: Remove tmux dependency from server/index.ts
 *
 * This script performs the following transformations:
 * 1. Removes tmux-related functions and variables
 * 2. Replaces tmux calls with SessionManager methods
 * 3. Updates imports
 * 4. Adds SessionManager initialization
 *
 * Usage: node scripts/migrate-tmux.js
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SERVER_FILE = path.join(__dirname, '../server/index.ts')
const BACKUP_FILE = path.join(__dirname, '../server/index.ts.backup')

console.log('🔄 Starting tmux migration...\n')

// Step 1: Create backup
if (!fs.existsSync(BACKUP_FILE)) {
  console.log('📦 Creating backup: server/index.ts.backup')
  fs.copyFileSync(SERVER_FILE, BACKUP_FILE)
} else {
  console.log('✅ Backup already exists: server/index.ts.backup')
}

let content = fs.readFileSync(SERVER_FILE, 'utf-8')

// Step 2: Remove imports
console.log('\n🗑️  Removing obsolete imports...')
content = content.replace(/import \{ exec, execFile \} from 'child_process'/g, '')
content = content.replace(/import \{ hostname, tmpdir \} from 'os'/g, "import { hostname } from 'os'")
content = content.replace(/import \{ randomUUID, randomBytes \} from 'crypto'/g, "import { randomUUID } from 'crypto'")

// Step 3: Add SessionManager import
console.log('➕ Adding SessionManager import...')
if (!content.includes("import { SessionManager } from './SessionManager.js'")) {
  content = content.replace(
    /(import { ProjectsManager } from '.\/ProjectsManager\.js')/,
    "$1\nimport { SessionManager } from './SessionManager.js'"
  )
}

// Step 4: Remove TMUX_SESSION constant
console.log('🗑️  Removing TMUX_SESSION constant...')
content = content.replace(/const TMUX_SESSION = .+\n/, '')

// Step 5: Add SESSION_LOG_FILE constant
console.log('➕ Adding SESSION_LOG_FILE constant...')
if (!content.includes('SESSION_LOG_FILE')) {
  content = content.replace(
    /(const TILES_FILE = .+)/,
    "$1\nconst SESSION_LOG_FILE = resolve(expandHome('~/.vibecraft/data/sessions.log'))"
  )
}

// Step 6: Remove tmux-related variables
console.log('🗑️  Removing tmux-related variables...')
content = content.replace(/const EXEC_PATH = \[[\s\S]+?\]\.join\(':'\)\n/, '')
content = content.replace(/const EXEC_OPTIONS = \{ env: \{ \.\.\.process\.env, PATH: EXEC_PATH \} \}\n/, '')
content = content.replace(/let lastTmuxHash = ''\n/, '')

// Step 7: Remove tmux-related functions (mark for manual review)
console.log('\n⚠️  Marking tmux functions for removal (manual review required)...')
const functionsToRemove = [
  'validateTmuxSession',
  'execFileAsync',
  'sendToTmuxSafe',
  'pollTokens',
  'startTokenPolling',
  'pollPermissions',
  'startPermissionPolling',
  'sendPermissionResponse'
]

functionsToRemove.forEach(funcName => {
  const regex = new RegExp(`\\/\\*\\*[\\s\\S]*?\\*\\/\\nfunction ${funcName}[\\s\\S]+?\\n\\}\\n`, 'g')
  const asyncRegex = new RegExp(`\\/\\*\\*[\\s\\S]*?\\*\\/\\nasync function ${funcName}[\\s\\S]+?\\n\\}\\n`, 'g')

  if (content.match(regex) || content.match(asyncRegex)) {
    console.log(`  📌 Found: ${funcName}() - needs manual removal`)
  }
})

// Step 8: Add SessionManager initialization
console.log('\n➕ Adding SessionManager initialization...')
const sessionManagerInit = `
/** Cross-platform session manager (replaces tmux) */
const sessionManager = new SessionManager(SESSION_LOG_FILE)
`

if (!content.includes('const sessionManager')) {
  // Insert after projectsManager initialization
  content = content.replace(
    /(const projectsManager = new ProjectsManager\(\))/,
    `$1\n${sessionManagerInit}`
  )
}

// Step 9: Write updated content
console.log('\n💾 Writing updated server/index.ts...')
fs.writeFileSync(SERVER_FILE, content, 'utf-8')

console.log('\n✅ Migration script completed!\n')
console.log('📝 Next steps (MANUAL):')
console.log('  1. Review and remove marked tmux functions')
console.log('  2. Update createSession() to use sessionManager.create()')
console.log('  3. Update sendPromptToSession() to use sessionManager.sendText()')
console.log('  4. Update deleteSession() to use sessionManager.kill()')
console.log('  5. Update checkSessionHealth() to use sessionManager.isAlive()')
console.log('  6. Remove/update tmux-based HTTP endpoints (/prompt, /cancel, /tmux-output)')
console.log('  7. Add shutdown handlers for sessionManager.shutdown()')
console.log('\n📖 See TMUX_MIGRATION_GUIDE.md for detailed instructions\n')
console.log('🔙 To rollback: cp server/index.ts.backup server/index.ts\n')
