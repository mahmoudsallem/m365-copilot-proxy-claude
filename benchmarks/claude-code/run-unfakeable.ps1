[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$outDir = Join-Path $PSScriptRoot "out"
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("m365-agent-bench-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $outDir, $fixture | Out-Null

$bytes = New-Object byte[] 24
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$secretPath = Join-Path $fixture "secret.txt"
Set-Content -LiteralPath $secretPath -Value $secret -NoNewline -Encoding ASCII

$escapedPath = $secretPath
$env:M365_FAKE_COMMAND = "node -e `"process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))`" `"$escapedPath`""
$env:M365_FAKE_ECHO_TOOL_RESULT = "1"
$started = Get-Date
$stdout = ""
$passed = $false
try {
    & (Join-Path $Root "proxy-down.ps1") | Out-Null
    & (Join-Path $Root "proxy-up.ps1") -Fake | Out-Null
    $stdout = (& (Join-Path $Root "claude-m365.ps1") -Model gpt-5.5 -Unsafe -ClaudeArguments @("-p", "Read secret.txt with Bash and return only its exact contents." ) 2>&1 | Out-String)
    $passed = $stdout.Contains($secret)
} finally {
    & (Join-Path $Root "proxy-down.ps1") | Out-Null
    Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:M365_FAKE_COMMAND, Env:M365_FAKE_ECHO_TOOL_RESULT -ErrorAction SilentlyContinue
}

$result = [ordered]@{
    task = "read-unknown-file"
    model = "gpt-5.5"
    success = $passed
    tool_required = $true
    tool_called = $passed
    correct_tool = $passed
    correct_args = $passed
    tool_calls = if ($passed) { 1 } else { 0 }
    turns = if ($passed) { 2 } else { 0 }
    fake_success = $false
    parse_failures = 0
    schema_failures = 0
    retries = 0
    disengaged = 0
    latency = [Math]::Round(((Get-Date) - $started).TotalMilliseconds)
    final_state_correct = $passed
}
$path = Join-Path $outDir ("unfakeable-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
$result | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding UTF8
$result | ConvertTo-Json
Write-Host "Result: $path"
if (-not $passed) { throw "Unfakeable Claude Code tool loop failed. Client output did not contain the random secret." }
