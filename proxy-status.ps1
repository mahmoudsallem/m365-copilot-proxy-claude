# Pure Windows PowerShell script to check status of M365 Copilot Proxy
$configDir = Join-Path $env:USERPROFILE ".config\m365-copilot-proxy"
$stateDir  = Join-Path $env:USERPROFILE ".local\state\m365-copilot-proxy"
$envFile   = Join-Path $configDir "proxy.env"
$pidFile   = Join-Path $stateDir "proxy.pid"
$logFile   = Join-Path $stateDir "proxy.log"

if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $name = $matches[1]
            $val = $matches[2].Trim('"', "'")
            [Environment]::SetEnvironmentVariable($name, $val, "Process")
            Set-Item -Path "Env:\$name" -Value $val
        }
    }
}

$port = if ($env:PORT) { $env:PORT } else { "4141" }
$apiUrl = "http://127.0.0.1:$port"
$apiKey = if ($env:M365_PROXY_API_KEY) { $env:M365_PROXY_API_KEY } else { "m365" }

$isHealthy = $false
try {
    $out = curl.exe -s -f "$apiUrl/v1/models"
    if ($out -and $out -match '"object"\s*:\s*"list"') {
        $isHealthy = $true
    }
} catch {}

$pidVal = $null
if (Test-Path $pidFile) {
    $pidVal = Get-Content $pidFile -ErrorAction SilentlyContinue
}

if ($isHealthy) {
    Write-Host "Proxy: RUNNING and HEALTHY at $apiUrl $(if ($pidVal) { "(PID $pidVal)" })" -ForegroundColor Green
    Write-Host "Bearer authentication: configured (key hidden)" -ForegroundColor Cyan
} else {
    Write-Host "Proxy: STOPPED or Unhealthy at $apiUrl" -ForegroundColor Yellow
}
if (Test-Path $logFile) {
    Write-Host "Log file: $logFile" -ForegroundColor Gray
}
