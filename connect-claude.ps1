[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$Model = "gpt-5.5",

    [string]$SessionId,

    # Explicit opt-in to --dangerously-skip-permissions. Never the default:
    # normal Claude Code permission prompts remain the safe path.
    [switch]$Unsafe,

    [switch]$NewSession
)

# Pure Windows PowerShell script to launch Claude Code connected to local M365 Proxy
$ErrorActionPreference = 'Stop'

$configDir = Join-Path $env:USERPROFILE ".config\m365-copilot-proxy"
$envFile   = Join-Path $configDir "proxy.env"

if (-not (Test-Path $envFile)) {
    Write-Host "Proxy configuration is missing. Run .\start-proxy.ps1 first." -ForegroundColor Red
    exit 1
}

Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
        $name = $matches[1]
        $val = $matches[2].Trim('"', "'")
        [Environment]::SetEnvironmentVariable($name, $val, "Process")
    }
}

$port = if ($env:PORT) { $env:PORT } else { "4141" }
$proxyUrl = "http://127.0.0.1:$port"
$selectedModel = $Model.Trim().ToLower()

# Reject unsupported misleading models before launching client
if ($selectedModel -match '^(fable|claude-fable|fable-4|mythos|claude-mythos|gpt-mythos|mythos-1)$') {
    Write-Host "Error: Unsupported model `"$Model`". This alias does not select a distinct upstream model. Use `"gpt-5.5`" or `"auto`"." -ForegroundColor Red
    exit 1
}

# Display preset warning for compatibility aliases
if ($selectedModel -match '^(sol|terra|luna|codex|openai-codex|gpt-codex|codex-5|gpt-5\.6)$') {
    Write-Host "Notice: `"$Model`" is a preset backed by canonical model `"gpt-5.5`"." -ForegroundColor Yellow
    $selectedModel = "gpt-5.5"
}

$apiKey = if ($env:M365_PROXY_API_KEY) { $env:M365_PROXY_API_KEY } else { "m365" }

$env:ANTHROPIC_BASE_URL = $proxyUrl
# AUTH_TOKEN only — setting ANTHROPIC_API_KEY too makes Claude Code warn about
# ambiguous auth ("Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set").
$env:ANTHROPIC_AUTH_TOKEN = $apiKey
Remove-Item Env:\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
$env:ANTHROPIC_MODEL = $selectedModel
$env:ANTHROPIC_SMALL_FAST_MODEL = $selectedModel
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
$env:DISABLE_TELEMETRY = "1"
$env:DISABLE_ERROR_REPORTING = "1"
$env:DISABLE_BUG_COMMAND = "1"

# Per-process conversation identity: every launch gets its own x-m365-session-id
# so two Claude Code processes (or two hosts on the same repo + prompt) can never
# fuse into one shared M365 thread via the proxy's content fingerprint.
if ($env:ANTHROPIC_CUSTOM_HEADERS -notmatch 'x-m365-session-id') {
    $sessionHeader = "x-m365-session-id: cc-$([guid]::NewGuid().ToString('N'))"
    $env:ANTHROPIC_CUSTOM_HEADERS = if ($env:ANTHROPIC_CUSTOM_HEADERS) { "$env:ANTHROPIC_CUSTOM_HEADERS`n$sessionHeader" } else { $sessionHeader }
}

Write-Host "[claude-m365] Connected to proxy=$proxyUrl model=$selectedModel session=$($env:ANTHROPIC_CUSTOM_HEADERS -replace '.*x-m365-session-id: ','' -split "`n" | Select-Object -Last 1)" -ForegroundColor Cyan
Write-Host "Available canonical models: auto, gpt-5.5, gpt-5.5-quick, gpt-5.5-think-deeper, claude-sonnet, claude-opus, quick, think-deeper" -ForegroundColor Gray
Write-Host "Available presets: sol, terra, luna, codex, haiku" -ForegroundColor DarkGray

$claudeArgs = @("--model", $selectedModel)
if ($Unsafe) {
    Write-Host "[claude-m365] UNSAFE MODE: permission prompts disabled (--dangerously-skip-permissions)" -ForegroundColor Yellow
    $claudeArgs += "--dangerously-skip-permissions"
}

if ($SessionId) {
    $claudeArgs += @("--resume", $SessionId)
}

if ($args) {
    $claudeArgs += $args
}

claude @claudeArgs
$exitCode = $LASTEXITCODE
exit $exitCode
