# Backward-compatible advanced entry point. The maintained Windows lifecycle is
# implemented by proxy-up.ps1 so PID checks, generated secrets, and health
# verification cannot drift between launchers.
$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "proxy-up.ps1") @args
exit $LASTEXITCODE
