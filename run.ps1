# run.ps1 — install, build, and start the m365-copilot-proxy on Windows.
#
#   .\run.ps1              # install+build+serve (auto: real M365 if credentials
#                          #   exist at %USERPROFILE%\.config\opencode-m365, else FAKE mode)
#   .\run.ps1 -Fake        # force offline scripted backend (no quota, no auth)
#   .\run.ps1 -Tui         # same setup, then launch the interactive TUI
#   .\run.ps1 -Dev         # hot-reload Nitro dev server instead of built output
#   .\run.ps1 -Fresh       # force reinstall + rebuild
#
# Env: PORT (default 4141), CLAUDE_BIN, M365_PROXY_API_KEY, M365_SYSTEM_PROMPT.
param(
    [switch]$Fake,
    [switch]$Tui,
    [switch]$Dev,
    [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not $env:PORT) { $env:PORT = "4141" }
$Mode = "auto"

function Log([string]$msg)  { Write-Host "[run] $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "[run] $msg" -ForegroundColor Yellow }

# --- pnpm via corepack (no global install needed) ----------------------------
$pnpm = @()
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    $pnpm = @("pnpm")
} elseif (Get-Command corepack -ErrorAction SilentlyContinue) {
    $pnpm = @("corepack", "pnpm")
    Log "using corepack pnpm"
} else {
    Write-Host "[run] ERROR: neither pnpm nor corepack found. Install Node.js LTS first: winget install OpenJS.NodeJS.LTS" -ForegroundColor Red
    exit 1
}

# --- install -------------------------------------------------------------------
if ($Fresh -or -not (Test-Path "$Root\node_modules")) {
    Log "installing dependencies..."
    & $pnpm[0] $pnpm[1..($pnpm.Length-1)] install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Log "dependencies present (use -Fresh to reinstall)"
}

# --- build -----------------------------------------------------------------------
if ($Fresh -or -not (Test-Path "$Root\packages\proxy\.output\server\index.mjs")) {
    Log "building all packages..."
    & $pnpm[0] $pnpm[1..($pnpm.Length-1)] -r build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Log "build output present (use -Fresh to rebuild)"
}

# --- mode selection -----------------------------------------------------------------
$secrets = Join-Path $env:USERPROFILE ".config\opencode-m365\secrets.json"
if ($Mode -eq "auto") {
    if ($Fake) { $Mode = "fake" }
    elseif (Test-Path $secrets) { $Mode = "live" }
    else {
        $Mode = "fake"
        Warn "no credentials at $secrets - starting in OFFLINE FAKE MODE."
        Warn "scripted backend: everything works end-to-end except it is not a real model."
        Warn "add secrets.json (README, Authentication section) then re-run for live M365."
    }
}

if ($Mode -eq "fake") {
    $env:M365_FAKE_MODE = "1"
    Log "starting proxy in FAKE mode on http://127.0.0.1:$($env:PORT)"
} else {
    Log "starting proxy against live M365 on http://127.0.0.1:$($env:PORT)"
}

# --- run --------------------------------------------------------------------------------
if ($Tui) {
    Log "launching TUI (start the proxy first in another terminal: .\run.ps1)"
    & node "$Root\bin\m365-tui.mjs"
    exit $LASTEXITCODE
}

if ($Dev) {
    & $pnpm[0] $pnpm[1..($pnpm.Length-1)] --filter "@m365-copilot/proxy" dev
    exit $LASTEXITCODE
}

Log "ready: $($env:PORT)/health /v1/models /v1/messages /v1/system-prompts (API key: `$env:M365_PROXY_API_KEY or default 'm365')"
& node "$Root\packages\proxy\.output\server\index.mjs"
exit $LASTEXITCODE
