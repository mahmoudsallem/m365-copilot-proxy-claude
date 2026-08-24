# run.ps1 — one-stop Windows bootstrap for m365-copilot-proxy.
#
# Installs everything needed, builds, starts the proxy, and (optionally)
# connects + runs Claude Code against it:
#
#   .\run.ps1                    # deps -> build -> serve (auto: live M365 if creds
#                                #   exist at %USERPROFILE%\.config\opencode-m365, else FAKE mode)
#   .\run.ps1 -Claude            # ...then CONNECT + RUN Claude Code through the proxy
#   .\run.ps1 -Fake -Claude      # offline scripted backend + Claude Code (no quota)
#   .\run.ps1 -Model claude-sonnet -Claude          # pick the model
#   .\run.ps1 -Model claude-sonnet -SystemPrompt "name:Anthropic/claude-code/claude-code-sonnet-4.6" -Claude
#   .\run.ps1 -Tui               # interactive TUI instead
#   .\run.ps1 -Dev               # hot-reload dev server
#   .\run.ps1 -Fresh             # force reinstall + rebuild
#   .\run.ps1 -KeepProxy -Claude # leave the proxy running after Claude exits
#
# First run will: install Node LTS via winget if missing, activate pnpm via
# corepack, pnpm install, build all packages, and install Claude Code via npm
# if no binary is found.
param(
    [switch]$Fake,
    [switch]$Tui,
    [switch]$Dev,
    [switch]$Fresh,
    [switch]$Claude,
    [switch]$KeepProxy,
    [string]$Model = $(if ($env:M365_DEFAULT_MODEL) { $env:M365_DEFAULT_MODEL } else { "gpt-5.5-think-deeper" }),
    [string]$SystemPrompt = ""
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not $env:PORT) { $env:PORT = "4141" }
$Mode = "auto"

function Log([string]$msg)  { Write-Host "[run] $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "[run] $msg" -ForegroundColor Yellow }
function Die([string]$msg)  { Write-Host "[run] ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- 1. Node.js ---------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Warn "Node.js not found."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Log "installing Node.js LTS via winget (one-time)..."
        & winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { Die "winget install failed; install Node LTS manually from https://nodejs.org" }
        # Refresh PATH for this session (winget updates the machine PATH only).
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                    [Environment]::GetEnvironmentVariable("Path", "User")
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node still not on PATH after install - open a new terminal and re-run." }
    } else {
        Die "no winget available. Install Node.js LTS manually: https://nodejs.org"
    }
}
Log "node $(node --version)"

# --- 2. dependencies ------------------------------------------------------------
function Invoke-Pnpm {
    param([string[]]$PnpmArgs)
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        & pnpm @PnpmArgs
    } elseif (Get-Command corepack -ErrorAction SilentlyContinue) {
        & corepack pnpm @PnpmArgs
    } else {
        # corepack ships with Node but may need enabling first
        & npm install -g pnpm
        if ($LASTEXITCODE -ne 0) { Die "could not provision pnpm" }
        & pnpm @PnpmArgs
    }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($Fresh -or -not (Test-Path (Join-Path $Root "node_modules"))) {
    Log "installing project dependencies..."
    Invoke-Pnpm @("install")
} else {
    Log "project dependencies present (use -Fresh to reinstall)"
}

# --- 3. build ---------------------------------------------------------------------
if ($Fresh -or -not (Test-Path (Join-Path $Root "packages/proxy/.output/server/index.mjs"))) {
    Log "building all packages..."
    Invoke-Pnpm @("-r", "build")
} else {
    Log "build output present (use -Fresh to rebuild)"
}

# --- 4. system-prompt corpus (optional content, never fatal) ------------------------
if (-not (Test-Path (Join-Path $Root "vendor/system-prompts-leaks/.git"))) {
    Log "fetching system-prompt corpus (github.com/asgeirtj/system_prompts_leaks)..."
    & node (Join-Path $Root "scripts/fetch-system-prompts.mjs")
    if ($LASTEXITCODE -ne 0) { Warn "corpus fetch failed (offline?) - continuing without it." }
} else {
    Log "system-prompt corpus present"
}

# --- 5. mode selection ----------------------------------------------------------------
$userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
$secrets = Join-Path $userHome ".config\opencode-m365\secrets.json"
if ($Mode -eq "auto") {
    if ($Fake) { $Mode = "fake" }
    elseif (Test-Path $secrets) { $Mode = "live" }
    else {
        $Mode = "fake"
        Warn "no credentials at $secrets - OFFLINE FAKE MODE (scripted backend, zero quota)."
        Warn "add secrets.json (README, Authentication) then re-run for live M365."
    }
}
if ($Mode -eq "fake") { $env:M365_FAKE_MODE = "1"; Log "mode: FAKE" } else { Log "mode: LIVE M365" }

$proxyUrl = "http://127.0.0.1:$($env:PORT)"
$apiKey = if ($env:M365_PROXY_API_KEY) { $env:M365_PROXY_API_KEY } else { "m365" }

# --- 6. Claude Code binary --------------------------------------------------------------
function Resolve-ClaudeBin {
    if ($env:CLAUDE_BIN -and (Test-Path $env:CLAUDE_BIN)) { return $env:CLAUDE_BIN }
    $candidates = @(
        (Join-Path $userHome "AppData\Roaming\npm\claude.cmd"),
        (Join-Path $userHome "AppData\Local\Programs\claude-code\claude.exe"),
        (Join-Path $userHome ".local\bin\claude.exe")
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

$claudeBin = Resolve-ClaudeBin
if (-not $claudeBin) {
    if ($Claude) {
        Log "installing Claude Code (npm i -g @anthropic-ai/claude-code)..."
        & npm install -g "@anthropic-ai/claude-code"
        if ($LASTEXITCODE -ne 0) { Die "Claude Code install failed; see https://docs.anthropic.com/en/docs/claude-code" }
        $claudeBin = Resolve-ClaudeBin
        if (-not $claudeBin) { Die "installed but still cannot find claude - set CLAUDE_BIN" }
    } elseif ($Tui) {
        Warn "Claude Code not installed yet; TUI launchers will fail until 'npm i -g @anthropic-ai/claude-code' (or re-run with -Claude)."
    }
}
if ($claudeBin) { Log "claude binary: $claudeBin" }

# --- 7. start the proxy -------------------------------------------------------------------
$proxyProcess = $null
function Test-ProxyUp {
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri "$proxyUrl/health" `
            -Headers @{ Authorization = "Bearer $apiKey" } -TimeoutSec 2
        return ($resp.StatusCode -eq 200)
    } catch { return $false }
}

$startedHere = $false
if (Test-ProxyUp) {
    Log "proxy already answering at $proxyUrl - reusing it."
} else {
    $serverScript = Join-Path $Root "packages/proxy/.output/server/index.mjs"
    # -WindowStyle exists only on Windows editions of Start-Process.
    $isWin = ($env:OS -eq "Windows_NT")
    if ($Dev) {
        Log "starting DEV proxy (hot reload) on $proxyUrl"
        $sp = @{ FilePath = "cmd.exe"; ArgumentList = @("/c", "corepack pnpm --filter @m365-copilot/proxy dev");
                 WorkingDirectory = $Root; PassThru = $true }
        if ($isWin) { $sp.WindowStyle = "Hidden" }
        $proxyProcess = Start-Process @sp
    } else {
        Log "starting proxy on $proxyUrl ($($Mode.ToUpper()) mode)"
        $sp = @{ FilePath = "node"; ArgumentList = @("`"$serverScript`""); WorkingDirectory = $Root; PassThru = $true;
                 RedirectStandardOutput = (Join-Path $Root "proxy.stdout.log"); RedirectStandardError = (Join-Path $Root "proxy.stderr.log") }
        if ($isWin) { $sp.WindowStyle = "Hidden" }
        $proxyProcess = Start-Process @sp
    }
    $startedHere = $true

    $up = $false
    for ($i = 0; $i -lt 80; $i++) {
        if (Test-ProxyUp) { $up = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $up) {
        if (Test-Path (Join-Path $Root "proxy.stderr.log")) { Get-Content (Join-Path $Root "proxy.stderr.log") | Select-Object -Last 20 | Write-Host }
        Die "proxy did not become healthy within 40s"
    }
}
Log "proxy healthy at $proxyUrl"

# --- 8. what to launch ------------------------------------------------------------------------
if ($Tui) {
    Log "launching TUI..."
    try {
        & node (Join-Path $Root "bin/m365-tui.mjs")
    } finally {
        if ($startedHere -and -not $KeepProxy -and $proxyProcess) {
            Log "stopping proxy"; $proxyProcess.Kill() | Out-Null
        }
    }
    exit $LASTEXITCODE
}

if (-not $Claude) {
    Log "serving. Ctrl+C to stop. Endpoints: /health /v1/models /v1/messages /v1/system-prompts"
    try {
        while ($true) { Start-Sleep -Seconds 3600 }
    } finally {
        if ($startedHere -and $proxyProcess) { $proxyProcess.Kill() | Out-Null }
    }
}

# --- 9. connect Claude Code to the proxy and run it ---------------------------------------------
Log "connecting Claude Code -> $proxyUrl (model: $Model)"
try {
    $env:ANTHROPIC_BASE_URL = $proxyUrl
    $env:ANTHROPIC_AUTH_TOKEN = $apiKey
    $env:ANTHROPIC_MODEL = $Model
    $env:ANTHROPIC_SMALL_FAST_MODEL = $Model
    if ($SystemPrompt) {
        $env:ANTHROPIC_CUSTOM_HEADERS = "x-m365-system-prompt: $SystemPrompt"
        Log "routing system prompt: $SystemPrompt (browse: GET /v1/system-prompts)"
    } else {
        Remove-Item Env:ANTHROPIC_CUSTOM_HEADERS -ErrorAction SilentlyContinue
    }
    $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
    $env:DISABLE_TELEMETRY = "1"
    $env:DISABLE_ERROR_REPORTING = "1"
    $env:DISABLE_BUG_COMMAND = "1"
    Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:CLAUDE_CODE_USE_BEDROCK -ErrorAction SilentlyContinue
    Remove-Item Env:CLAUDE_CODE_USE_VERTEX -ErrorAction SilentlyContinue

    Write-Host ""
    $modeTag = $Mode.ToUpper()
    if ($Mode -eq "fake") { $modeTag = "$modeTag (scripted backend!)" }
    Write-Host "=========================================================" -ForegroundColor Green
    Write-Host " Claude Code is talking to: $proxyUrl" -ForegroundColor Green
    Write-Host " model: $Model  mode: $modeTag"
    Write-Host " MCP/skills/plugins are client-side - configure as usual." -ForegroundColor DarkGray
    Write-Host "=========================================================" -ForegroundColor Green
    Write-Host ""

    & $claudeBin --model $Model @args
    exit $LASTEXITCODE
} finally {
    if ($startedHere -and -not $KeepProxy -and $proxyProcess) {
        Log "stopping proxy"
        $proxyProcess.Kill() | Out-Null
    }
}
