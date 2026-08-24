# watchdog: keeps the m365 proxy alive. Spawned detached by run.ps1.
# Loop: if /health is down -> respawn the built server. Exits when the
# stop-file appears (run.ps1 creates it on -StopProxy / shutdown).
param(
    [Parameter(Mandatory)] [string]$Root,
    [Parameter(Mandatory)] [int]$Port
)
$serverScript = Join-Path $Root "packages/proxy/.output/server/index.mjs"
$stopFile = Join-Path $Root ".proxy-watchdog-stop"
$url = "http://127.0.0.1:$Port/health"
$isWin = ($env:OS -eq "Windows_NT")

while ($true) {
    if (Test-Path $stopFile) {
        Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
        break
    }

    $up = $false
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $url `
            -Headers @{ Authorization = "Bearer m365" } -TimeoutSec 3 -ErrorAction Stop
        $up = ($resp.StatusCode -eq 200)
    } catch { $up = $false }

    if (-not $up) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $sp = @{
            FilePath               = "node"
            ArgumentList           = @("`"$serverScript`"")
            WorkingDirectory       = $Root
            PassThru               = $true
            RedirectStandardOutput = (Join-Path $Root "proxy.stdout.$stamp.log")
            RedirectStandardError  = (Join-Path $Root "proxy.stderr.$stamp.log")
        }
        if ($isWin) { $sp.WindowStyle = "Hidden" }
        try {
            $proc = Start-Process @sp
            if (-not $proc) { Write-Warning "watchdog: Start-Process returned null" }
        } catch {
            Write-Warning "watchdog: respawn failed: $($_.Exception.Message)"
        }
    }
    Start-Sleep -Seconds 5
}
