[CmdletBinding()]
param(
    [string]$Model = $(if ($env:M365_DEFAULT_MODEL) { $env:M365_DEFAULT_MODEL } else { "gpt-5.5" }),
    [ValidatePattern('^[A-Za-z0-9._:-]{1,128}$')]
    [string]$SessionId,
    [switch]$NewSession,
    [switch]$Unsafe,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArguments
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$configDir = Join-Path $env:USERPROFILE ".config\m365-copilot-proxy"
$envFile = Join-Path $configDir "proxy.env"
$proxyUrl = "http://127.0.0.1:4141"

if ($SessionId -and $NewSession) { throw "Use either -SessionId to resume proxy context or -NewSession, not both." }

function Test-M365Proxy {
    try {
        $health = Invoke-RestMethod -Uri "$proxyUrl/health" -TimeoutSec 2
        return $health.status -eq "ok" -and $health.service -eq "m365-copilot-proxy"
    } catch { return $false }
}

if (-not (Test-M365Proxy)) {
    Write-Host "[claude-m365] proxy is not running; starting it now" -ForegroundColor Cyan
    & (Join-Path $Root "proxy-up.ps1") -Model $Model
    if ($LASTEXITCODE -ne 0 -or -not (Test-M365Proxy)) { throw "M365 proxy could not be started." }
}
if (-not (Test-Path -LiteralPath $envFile)) { throw "Proxy configuration is missing: $envFile" }

$proxyKey = $null
Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^\s*M365_PROXY_API_KEY=(.*)$') { $proxyKey = $matches[1].Trim().Trim('"', "'") }
}
if (-not $proxyKey) { throw "M365_PROXY_API_KEY is missing from $envFile" }

$catalog = Invoke-RestMethod -Uri "$proxyUrl/v1/models" -TimeoutSec 10
$selected = $catalog.data | Where-Object { $_.id -eq $Model } | Select-Object -First 1
if (-not $selected) {
    $available = ($catalog.data | Select-Object -ExpandProperty id | Sort-Object) -join ", "
    throw "Unknown model '$Model'. Available models: $available"
}
$resolvedModel = if ($selected.m365.canonicalModel) { $selected.m365.canonicalModel } else { $selected.id }
$tone = if ($selected.m365.tone) { $selected.m365.tone } else { "unknown" }

$claude = if ($env:CLAUDE_BIN -and (Test-Path -LiteralPath $env:CLAUDE_BIN)) {
    $env:CLAUDE_BIN
} else {
    (Get-Command claude -ErrorAction SilentlyContinue).Source
}
if (-not $claude) { throw "Claude Code is not installed. Install the real Claude Code CLI, then rerun." }

$proxySession = if ($SessionId) { $SessionId } else { "cc-$([guid]::NewGuid().ToString('N'))" }
$headers = @()
if ($env:ANTHROPIC_CUSTOM_HEADERS) {
    $headers += @($env:ANTHROPIC_CUSTOM_HEADERS -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^x-m365-session-id\s*:' })
}
$headers += "x-m365-session-id: $proxySession"

$names = @(
    "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"
)
$saved = @{}
foreach ($name in $names) {
    $item = Get-Item "Env:$name" -ErrorAction SilentlyContinue
    $saved[$name] = [pscustomobject]@{ Exists = $null -ne $item; Value = if ($item) { $item.Value } else { $null } }
}

try {
    $env:ANTHROPIC_BASE_URL = $proxyUrl
    $env:ANTHROPIC_AUTH_TOKEN = $proxyKey
    $env:ANTHROPIC_MODEL = $selected.id
    $env:ANTHROPIC_SMALL_FAST_MODEL = $selected.id
    $env:ANTHROPIC_CUSTOM_HEADERS = $headers -join "`n"
    $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
    Remove-Item Env:ANTHROPIC_API_KEY, Env:CLAUDE_CODE_USE_BEDROCK, Env:CLAUDE_CODE_USE_VERTEX -ErrorAction SilentlyContinue

    Write-Host "M365 proxy: connected" -ForegroundColor Green
    Write-Host "Proxy: $proxyUrl"
    Write-Host "Requested: $Model"
    Write-Host "Resolved: $resolvedModel"
    Write-Host "M365 tone: $tone"
    Write-Host "Session: $proxySession"
    Write-Host "Permissions: $(if ($Unsafe) { 'UNSAFE (explicit bypass)' } else { 'normal' })"

    $launchArgs = @("--model", $selected.id)
    if ($DebugPreference -ne "SilentlyContinue") { $launchArgs += "--debug" }
    if ($Unsafe) { $launchArgs += "--dangerously-skip-permissions" }
    if ($ClaudeArguments) { $launchArgs += $ClaudeArguments }
    # Claude writes informational notices to stderr. Windows PowerShell can
    # promote those native stderr lines to terminating ErrorRecords when the
    # caller captures output, so keep the child governed by its exit code.
    $priorErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $claude @launchArgs
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $priorErrorPreference
    }
} finally {
    foreach ($name in $names) {
        if ($saved[$name].Exists) { [Environment]::SetEnvironmentVariable($name, $saved[$name].Value, "Process") }
        else { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    }
}
exit $code
