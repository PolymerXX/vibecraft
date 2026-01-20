# Vibecraft Hook - Captures Claude Code events for 3D visualization (Windows PowerShell)
#
# This script is called by Claude Code hooks and:
# 1. Reads the hook input from stdin
# 2. Transforms it into our event format
# 3. Appends to the events JSONL file
# 4. Optionally notifies the WebSocket server
#
# Installed to: ~/.vibecraft/hooks/vibecraft-hook.ps1
# Run `npx vibecraft setup` to install/update this hook.

param()

$ErrorActionPreference = "Stop"

# =============================================================================
# Configuration
# =============================================================================

$VIBECRAFT_DATA_DIR = if ($env:VIBECRAFT_DATA_DIR) { $env:VIBECRAFT_DATA_DIR } else { Join-Path $env:USERPROFILE ".vibecraft\data" }
$EVENTS_FILE = if ($env:VIBECRAFT_EVENTS_FILE) { $env:VIBECRAFT_EVENTS_FILE } else { Join-Path $VIBECRAFT_DATA_DIR "events.jsonl" }
$WS_NOTIFY_URL = if ($env:VIBECRAFT_WS_NOTIFY) { $env:VIBECRAFT_WS_NOTIFY } else { "http://localhost:4003/event" }
$ENABLE_WS_NOTIFY = if ($env:VIBECRAFT_ENABLE_WS_NOTIFY) { $env:VIBECRAFT_ENABLE_WS_NOTIFY -eq "true" } else { $true }

# Ensure data directory exists
$dataDir = Split-Path $EVENTS_FILE -Parent
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}

# =============================================================================
# Read and Parse Input
# =============================================================================

$input_data = $input | Out-String
if ([string]::IsNullOrWhiteSpace($input_data)) {
    $input_data = [Console]::In.ReadToEnd()
}

try {
    $inputObj = $input_data | ConvertFrom-Json
} catch {
    Write-Error "Failed to parse input JSON: $_"
    exit 1
}

$hook_event_name = if ($inputObj.hook_event_name) { $inputObj.hook_event_name } else { "unknown" }
$session_id = if ($inputObj.session_id) { $inputObj.session_id } else { "unknown" }
$cwd = if ($inputObj.cwd) { $inputObj.cwd } else { "" }

# Generate unique event ID and timestamp
$timestamp = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$event_id = "$session_id-$timestamp-$(Get-Random)"

# =============================================================================
# Event Type Mapping
# =============================================================================

$event_type = switch ($hook_event_name) {
    "PreToolUse"       { "pre_tool_use" }
    "PostToolUse"      { "post_tool_use" }
    "Stop"             { "stop" }
    "SubagentStop"     { "subagent_stop" }
    "SessionStart"     { "session_start" }
    "SessionEnd"       { "session_end" }
    "UserPromptSubmit" { "user_prompt_submit" }
    "Notification"     { "notification" }
    "PreCompact"       { "pre_compact" }
    default            { "unknown" }
}

# =============================================================================
# Build Event Object
# =============================================================================

$event = @{
    id = $event_id
    timestamp = $timestamp
    type = $event_type
    sessionId = $session_id
    cwd = $cwd
}

switch ($event_type) {
    "pre_tool_use" {
        $tool_name = if ($inputObj.tool_name) { $inputObj.tool_name } else { "unknown" }
        $tool_input = if ($inputObj.tool_input) { $inputObj.tool_input } else { @{} }
        $tool_use_id = if ($inputObj.tool_use_id) { $inputObj.tool_use_id } else { "" }
        $transcript_path = if ($inputObj.transcript_path) { $inputObj.transcript_path } else { "" }

        # Try to extract assistant text from transcript
        $assistant_text = ""
        if ($transcript_path -and (Test-Path $transcript_path)) {
            try {
                $transcriptContent = Get-Content $transcript_path -Tail 30 -Raw
                $transcriptLines = $transcriptContent -split "`n" | Where-Object { $_.Trim() }
                foreach ($line in $transcriptLines) {
                    try {
                        $entry = $line | ConvertFrom-Json
                        if ($entry.type -eq "assistant" -and $entry.message.content) {
                            foreach ($content in $entry.message.content) {
                                if ($content.type -eq "text") {
                                    $assistant_text += $content.text + "`n"
                                }
                            }
                        }
                    } catch { }
                }
            } catch { }
        }

        $event.tool = $tool_name
        $event.toolInput = $tool_input
        $event.toolUseId = $tool_use_id
        $event.assistantText = $assistant_text.Trim()
    }

    "post_tool_use" {
        $tool_name = if ($inputObj.tool_name) { $inputObj.tool_name } else { "unknown" }
        $tool_input = if ($inputObj.tool_input) { $inputObj.tool_input } else { @{} }
        $tool_response = if ($inputObj.tool_response) { $inputObj.tool_response } else { @{} }
        $tool_use_id = if ($inputObj.tool_use_id) { $inputObj.tool_use_id } else { "" }
        $success = if ($null -ne $inputObj.tool_response.success) { $inputObj.tool_response.success } else { $true }

        $event.tool = $tool_name
        $event.toolInput = $tool_input
        $event.toolResponse = $tool_response
        $event.toolUseId = $tool_use_id
        $event.success = $success
    }

    { $_ -in @("stop", "subagent_stop") } {
        $stop_hook_active = if ($null -ne $inputObj.stop_hook_active) { $inputObj.stop_hook_active } else { $false }
        $transcript_path = if ($inputObj.transcript_path) { $inputObj.transcript_path } else { "" }

        # Try to extract latest assistant response from transcript
        $assistant_response = ""
        if ($transcript_path -and (Test-Path $transcript_path)) {
            try {
                $transcriptContent = Get-Content $transcript_path -Tail 200 -Raw
                $transcriptLines = $transcriptContent -split "`n" | Where-Object { $_.Trim() }
                $lastAssistant = $null
                foreach ($line in $transcriptLines) {
                    try {
                        $entry = $line | ConvertFrom-Json
                        if ($entry.type -eq "assistant" -and $entry.message.content) {
                            $lastAssistant = $entry
                        }
                    } catch { }
                }
                if ($lastAssistant) {
                    foreach ($content in $lastAssistant.message.content) {
                        if ($content.type -eq "text") {
                            $assistant_response += $content.text + "`n"
                        }
                    }
                }
            } catch { }
        }

        $event.stopHookActive = $stop_hook_active
        $event.response = $assistant_response.Trim()
    }

    "session_start" {
        $source_type = if ($inputObj.source) { $inputObj.source } else { "startup" }
        $event.source = $source_type
    }

    "session_end" {
        $reason = if ($inputObj.reason) { $inputObj.reason } else { "other" }
        $event.reason = $reason
    }

    "user_prompt_submit" {
        $prompt = if ($inputObj.prompt) { $inputObj.prompt } else { "" }
        $event.prompt = $prompt
    }

    "notification" {
        $message = if ($inputObj.message) { $inputObj.message } else { "" }
        $notification_type = if ($inputObj.notification_type) { $inputObj.notification_type } else { "unknown" }
        $event.message = $message
        $event.notificationType = $notification_type
    }

    "pre_compact" {
        $trigger = if ($inputObj.trigger) { $inputObj.trigger } else { "manual" }
        $custom_instructions = if ($inputObj.custom_instructions) { $inputObj.custom_instructions } else { "" }
        $event.trigger = $trigger
        $event.customInstructions = $custom_instructions
    }

    default {
        $event.raw = $inputObj
    }
}

# =============================================================================
# Output Event
# =============================================================================

# Convert to compact JSON
$eventJson = $event | ConvertTo-Json -Compress -Depth 10

# Append event to JSONL file
Add-Content -Path $EVENTS_FILE -Value $eventJson -Encoding UTF8

# Notify WebSocket server (fire and forget, don't block Claude)
if ($ENABLE_WS_NOTIFY) {
    try {
        $job = Start-Job -ScriptBlock {
            param($url, $body)
            try {
                Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType "application/json" -TimeoutSec 2 | Out-Null
            } catch { }
        } -ArgumentList $WS_NOTIFY_URL, $eventJson

        # Don't wait for the job - fire and forget
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    } catch { }
}

exit 0
