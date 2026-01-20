# Vibecraft Windows Setup Script
# This script sets up Vibecraft hooks for Windows

param(
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$VIBECRAFT_DIR = Join-Path $env:USERPROFILE ".vibecraft"
$HOOKS_DIR = Join-Path $VIBECRAFT_DIR "hooks"
$DATA_DIR = Join-Path $VIBECRAFT_DIR "data"
$CLAUDE_SETTINGS = Join-Path $env:USERPROFILE ".claude\settings.json"

function Write-ColorOutput($ForegroundColor) {
    $fc = $host.UI.RawUI.ForegroundColor
    $host.UI.RawUI.ForegroundColor = $ForegroundColor
    if ($args) {
        Write-Output $args
    }
    $host.UI.RawUI.ForegroundColor = $fc
}

function Install-Vibecraft {
    Write-Host ""
    Write-Host "=== Vibecraft Windows Setup ===" -ForegroundColor Cyan
    Write-Host ""

    # Create directories
    Write-Host "Creating directories..." -ForegroundColor Yellow
    if (-not (Test-Path $VIBECRAFT_DIR)) {
        New-Item -ItemType Directory -Path $VIBECRAFT_DIR -Force | Out-Null
    }
    if (-not (Test-Path $HOOKS_DIR)) {
        New-Item -ItemType Directory -Path $HOOKS_DIR -Force | Out-Null
    }
    if (-not (Test-Path $DATA_DIR)) {
        New-Item -ItemType Directory -Path $DATA_DIR -Force | Out-Null
    }

    # Find the source hook script
    $ScriptDir = Split-Path -Parent $MyInvocation.ScriptName
    $PluginDir = Split-Path -Parent $ScriptDir
    $SourceHook = Join-Path $PluginDir "hooks\vibecraft-hook.ps1"

    if (-not (Test-Path $SourceHook)) {
        Write-Host "Error: Could not find vibecraft-hook.ps1 at $SourceHook" -ForegroundColor Red
        exit 1
    }

    # Copy hook script
    Write-Host "Installing hook script..." -ForegroundColor Yellow
    $DestHook = Join-Path $HOOKS_DIR "vibecraft-hook.ps1"
    Copy-Item -Path $SourceHook -Destination $DestHook -Force

    # Configure Claude Code settings
    Write-Host "Configuring Claude Code hooks..." -ForegroundColor Yellow

    $ClaudeDir = Split-Path -Parent $CLAUDE_SETTINGS
    if (-not (Test-Path $ClaudeDir)) {
        New-Item -ItemType Directory -Path $ClaudeDir -Force | Out-Null
    }

    # Build the hook command - use PowerShell to run the script
    $HookCommand = "powershell.exe -ExecutionPolicy Bypass -NoProfile -File `"$DestHook`""

    # Define hooks configuration
    $hooks = @{
        PreToolUse = @(
            @{
                matcher = "*"
                hooks = @(
                    @{
                        type = "command"
                        command = $HookCommand
                    }
                )
            }
        )
        PostToolUse = @(
            @{
                matcher = "*"
                hooks = @(
                    @{
                        type = "command"
                        command = $HookCommand
                    }
                )
            }
        )
        Stop = @(
            @{
                matcher = ""
                hooks = @(
                    @{
                        type = "command"
                        command = $HookCommand
                    }
                )
            }
        )
        SubagentStop = @(
            @{
                matcher = ""
                hooks = @(
                    @{
                        type = "command"
                        command = $HookCommand
                    }
                )
            }
        )
        SessionStart = @(
            @{
                matcher = ""
                hooks = @(
                    @{
                        type = "command"
                        command = $HookCommand
                    }
                )
            }
        )
        SessionEnd = @(
            @{
                matcher = ""
                hooks = @(
                    @{
                        type = "command"
                        command = $HookCommand
                    }
                )
            }
        )
        UserPromptSubmit = @(
            @{
                matcher = ""
                hooks = @(
                    @{
                        type = "command"
                        command = $HookCommand
                    }
                )
            }
        )
        Notification = @(
            @{
                matcher = ""
                hooks = @(
                    @{
                        type = "command"
                        command = $HookCommand
                    }
                )
            }
        )
    }

    # Load existing settings or create new
    if (Test-Path $CLAUDE_SETTINGS) {
        # Backup existing settings
        $BackupPath = "$CLAUDE_SETTINGS.backup.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -Path $CLAUDE_SETTINGS -Destination $BackupPath
        Write-Host "  Backed up existing settings to: $BackupPath" -ForegroundColor Gray

        $settings = Get-Content $CLAUDE_SETTINGS -Raw | ConvertFrom-Json
    } else {
        $settings = @{}
    }

    # Update hooks
    $settings | Add-Member -NotePropertyName "hooks" -NotePropertyValue $hooks -Force

    # Save settings
    $settings | ConvertTo-Json -Depth 10 | Set-Content $CLAUDE_SETTINGS -Encoding UTF8

    Write-Host ""
    Write-Host "=== Setup Complete! ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "Hook installed to: $DestHook" -ForegroundColor Gray
    Write-Host "Data directory: $DATA_DIR" -ForegroundColor Gray
    Write-Host "Settings updated: $CLAUDE_SETTINGS" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. Restart Claude Code to apply hooks"
    Write-Host "  2. Start Vibecraft server: npm run dev"
    Write-Host "  3. Open http://localhost:4002"
    Write-Host ""
}

function Uninstall-Vibecraft {
    Write-Host ""
    Write-Host "=== Vibecraft Windows Uninstall ===" -ForegroundColor Cyan
    Write-Host ""

    # Remove hooks from Claude settings
    if (Test-Path $CLAUDE_SETTINGS) {
        Write-Host "Removing hooks from Claude Code settings..." -ForegroundColor Yellow

        $settings = Get-Content $CLAUDE_SETTINGS -Raw | ConvertFrom-Json

        if ($settings.hooks) {
            $settings.PSObject.Properties.Remove("hooks")
            $settings | ConvertTo-Json -Depth 10 | Set-Content $CLAUDE_SETTINGS -Encoding UTF8
            Write-Host "  Hooks removed from settings" -ForegroundColor Gray
        }
    }

    # Remove hook script (keep data)
    $HookFile = Join-Path $HOOKS_DIR "vibecraft-hook.ps1"
    if (Test-Path $HookFile) {
        Remove-Item $HookFile -Force
        Write-Host "  Removed hook script" -ForegroundColor Gray
    }

    Write-Host ""
    Write-Host "=== Uninstall Complete! ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "Note: Data directory preserved at: $DATA_DIR" -ForegroundColor Gray
    Write-Host "      To remove data, delete: $VIBECRAFT_DIR" -ForegroundColor Gray
    Write-Host ""
}

# Main
if ($Uninstall) {
    Uninstall-Vibecraft
} else {
    Install-Vibecraft
}
