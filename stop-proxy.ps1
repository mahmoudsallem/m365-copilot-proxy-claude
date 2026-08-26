# Backward-compatible advanced entry point.
$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "proxy-down.ps1") @args
exit $LASTEXITCODE
