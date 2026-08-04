[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$Model = "gpt-5.5",

    [string]$SessionId,

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
$env:ANTHROPIC_AUTH_TOKEN = $apiKey
$env:ANTHROPIC_API_KEY = $apiKey
$env:ANTHROPIC_MODEL = $selectedModel
$env:ANTHROPIC_SMALL_FAST_MODEL = $selectedModel
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
$env:DISABLE_TELEMETRY = "1"
$env:DISABLE_ERROR_REPORTING = "1"
$env:DISABLE_BUG_COMMAND = "1"

Write-Host "[claude-m365] Connected to proxy=$proxyUrl model=$selectedModel" -ForegroundColor Cyan
Write-Host "Available canonical models: auto, gpt-5.5, gpt-5.5-quick, gpt-5.5-think-deeper, claude-sonnet, claude-opus, quick, think-deeper" -ForegroundColor Gray
Write-Host "Available presets: sol, terra, luna, codex, haiku" -ForegroundColor DarkGray

$claudeArgs = @("--model", $selectedModel, "--dangerously-skip-permissions")

if ($SessionId) {
    $claudeArgs += @("--resume", $SessionId)
}

if ($args) {
    $claudeArgs += $args
}

claude @claudeArgs
$exitCode = $LASTEXITCODE
exit $exitCode
