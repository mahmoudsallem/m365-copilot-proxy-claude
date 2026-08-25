# cc-doctor v2 - local Claude Code installation audit. No AI, instant.
# One optional registry lookup for the version check; -Offline skips it.
# Run:  powershell -NoProfile -File scripts\cc-doctor.ps1 [-Offline] [-Compact]
# Exit: 0 clean | 1 warnings | 2 failures

param(
    [switch]$Offline,
    [switch]$Compact
)
$script:Compact = $Compact

$ErrorActionPreference = 'Continue'
$t0 = [System.Diagnostics.Stopwatch]::StartNew()
$homeDir = $env:USERPROFILE
$sd = Join-Path $homeDir '.claude'
$cj = Join-Path $homeDir '.claude.json'
$settingsPath = Join-Path $sd 'settings.json'
$proj = 'E:\m365-copilot-proxy-claude'

$nOK = 0; $nWarn = 0; $nFail = 0; $nInfo = 0
$W = 64

function Banner([string]$Text) {
    if ($script:Compact) { return }
    Write-Host ''
    $dash = [Math]::Max(2, $W - $Text.Length - 4)
    Write-Host ('-- ' + $Text.ToUpper() + ' ' + ('-' * $dash)) -ForegroundColor DarkCyan
}
function Ok([string]$t) {
    $script:nOK++
    if (-not $script:Compact) { Write-Host ('  [OK]   ' + $t) -ForegroundColor Green }
}
function Warn([string]$t) { $script:nWarn++; Write-Host ('  [WARN] ' + $t) -ForegroundColor Yellow }
function Fail([string]$t) { $script:nFail++; Write-Host ('  [FAIL] ' + $t) -ForegroundColor Red }
function Info([string]$t) {
    $script:nInfo++
    if (-not $script:Compact) { Write-Host ('  [i]    ' + $t) -ForegroundColor Gray }
}
function Hint([string]$t) { Write-Host ('         fix: ' + $t) -ForegroundColor DarkYellow }

function VersionOf([string]$v) {
    if (-not $v) { return $null }
    return (($v -split '\s+')[0])
}
function IsOlder($a, $b) {
    if (-not $a -or -not $b) { return $false }
    $pa = "$a".Split('.'); $pb = "$b".Split('.')
    for ($i = 0; $i -lt [Math]::Max($pa.Count, $pb.Count); $i++) {
        $x = [long]0; $y = [long]0
        if ($i -lt $pa.Count) { [void][long]::TryParse((($pa[$i] -replace '\D', '')), [ref]$x) }
        if ($i -lt $pb.Count) { [void][long]::TryParse((($pb[$i] -replace '\D', '')), [ref]$y) }
        if ($x -lt $y) { return $true }
        if ($x -gt $y) { return $false }
    }
    return $false
}
function Test-NoBom([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    $bytes = [IO.File]::ReadAllBytes($path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Warn "UTF-8 BOM present: $path"
        Hint "[IO.File]::WriteAllText('$path', ([IO.File]::ReadAllText('$path')))"
    } else {
        Ok ("no BOM: " + (Split-Path $path -Leaf))
    }
}

Write-Host ('=' * $W)
Write-Host (' cc-doctor  |  ' + $env:COMPUTERNAME + '  |  ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
Write-Host ('=' * $W)
if (-not $script:Compact) {
    Write-Host (' [OK] fine   [WARN] attention   [FAIL] broken   [i] info') -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- install
Banner 'install'
$verRaw = (& claude --version 2>$null)
$ver = VersionOf $verRaw
if ($ver) { Ok "claude $ver" } else { Fail 'claude not on PATH'; Hint 'npm install -g @anthropic-ai/claude-code' }
$where = (where.exe claude 2>$null) -join '; '
if ($where) { Info ("shim: " + $where) }

$npmPrefix = & npm -g config get prefix 2>$null
$pkgJson = Join-Path $npmPrefix 'node_modules\@anthropic-ai\claude-code\package.json'
$method = 'unknown'
if ($npmPrefix -and (Test-Path -LiteralPath $pkgJson)) {
    $pv = & node -e "console.log(require(process.argv[1]).version)" $pkgJson 2>$null
    $method = 'npm'
    Ok "install method: npm-global ($pv)"
} else {
    Info 'no npm-global package (native install?)'
}
$stale = Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code'
if (Test-Path -LiteralPath $stale) {
    Warn "duplicate install shadowing PATH: $stale"
    Hint ("Remove-Item -Recurse -Force '" + $stale + "'")
} else {
    Ok 'single install, no shadowing duplicates'
}

$latest = $null
$netSecs = 0
if (-not $Offline) {
    Info 'checking npm registry for latest version...'
    $net = [System.Diagnostics.Stopwatch]::StartNew()
    $latest = (& npm view '@anthropic-ai/claude-code' version --fetch-timeout=5000 2>$null | Select-Object -First 1)
    $net.Stop()
    $netSecs = [math]::Round($net.Elapsed.TotalSeconds, 1)
    if (-not $latest) { Info "update check skipped (registry unreachable, ${netSecs}s)" }
}
if ($ver -and $latest) {
    if (IsOlder $ver $latest) {
        Warn "outdated: $ver -> latest $latest (registry ${netSecs}s)"
        if ($method -eq 'npm') { Hint 'npm install -g @anthropic-ai/claude-code@latest' } else { Hint 'claude update' }
        try { $s0 = [IO.File]::ReadAllText($settingsPath) | ConvertFrom-Json } catch { $s0 = $null }
        if (($env:DISABLE_AUTOUPDATER -eq '1') -or ($s0 -and $s0.env -and $s0.env.DISABLE_AUTOUPDATER -eq '1')) {
            Info 'auto-updater disabled by config (DISABLE_AUTOUPDATER=1): updates are manual'
        }
    } else {
        Ok ("up to date (" + $ver + " = latest)")
    }
}

# ---------------------------------------------------------- config files
Banner 'config files'
$j = $null
if (-not (Test-Path -LiteralPath $cj)) {
    Warn "missing: $cj"
} else {
    Test-NoBom $cj
    try {
        $j = [IO.File]::ReadAllText($cj) | ConvertFrom-Json
        $kb = [math]::Round((Get-Item -LiteralPath $cj).Length / 1kb, 1)
        Ok ".claude.json valid JSON ($kb KB)"
        $im = '(unset)'; if ($j.installMethod) { $im = $j.installMethod }
        $au = '(unset)'; if ($null -ne $j.autoUpdates) { $au = "$($j.autoUpdates)" }
        Info "numStartups: $($j.numStartups) | installMethod: $im | autoUpdates: $au"
        $mcpNames = @()
        if ($j.mcpServers) { $mcpNames = @($j.mcpServers.PSObject.Properties.Name) }
        Info ("user MCP servers ($($mcpNames.Count)): " + ($mcpNames -join ', '))
    } catch {
        Fail ".claude.json PARSE ERROR: $($_.Exception.Message)"
        Hint 'restore from backup, or rename the file so Claude Code regenerates it'
    }
}
$s = $null
if (-not (Test-Path -LiteralPath $settingsPath)) {
    Warn "missing: $settingsPath"
} else {
    Test-NoBom $settingsPath
    try {
        $s = [IO.File]::ReadAllText($settingsPath) | ConvertFrom-Json
        Ok 'settings.json valid JSON'
    } catch {
        Fail "settings.json PARSE ERROR: $($_.Exception.Message)"
    }
}

# --------------------------------------------------------------- settings
Banner 'settings'
if ($s) {
    $mode = '(unset)'
    if ($s.permissions -and $s.permissions.defaultMode) { $mode = $s.permissions.defaultMode }
    Info "permissions.defaultMode: $mode"
    if ($s.env -and $s.env.ANTHROPIC_BASE_URL) { Info "API base URL: $($s.env.ANTHROPIC_BASE_URL)" }

    if ($s.hooks) {
        foreach ($evt in $s.hooks.PSObject.Properties.Name) {
            foreach ($h in $s.hooks.$evt) {
                foreach ($hh in $h.hooks) {
                    $hp = "$($hh.command)"
                    $m = [regex]::Match($hp, '"([^"]+\.(js|ps1|py|cmd|bat))"')
                    if ($m.Success) { $hp = $m.Groups[1].Value }
                    $hp = [Environment]::ExpandEnvironmentVariables($hp)
                    Info "hook $evt [$($h.matcher)]"
                    if (Test-Path -LiteralPath $hp) { Ok "hook script exists: $hp" }
                    else { Warn "hook script MISSING: $hp"; Hint "create it or remove the hook from settings.json" }
                }
            }
        }
    } else { Info 'hooks: none' }

    $enabled = @(); $disabled = @()
    if ($s.enabledPlugins) {
        foreach ($p in $s.enabledPlugins.PSObject.Properties) {
            if ($p.Value) { $enabled += $p.Name } else { $disabled += $p.Name }
        }
    }
    if ($enabled.Count -gt 0)  { Info ("plugins enabled : " + ($enabled -join ', ')) }
    if ($disabled.Count -gt 0) { Info ("plugins disabled: " + ($disabled -join ', ') + "  (cached on disk, zero context cost)") }

    $ovr = @()
    if ($s.skillOverrides) {
        foreach ($o in $s.skillOverrides.PSObject.Properties) { $ovr += ("{0}={1}" -f $o.Name, $o.Value) }
    }
    if ($ovr.Count -gt 0) { Info ("skill overrides : " + ($ovr -join ', ')) }
} else {
    Info 'settings checks skipped (file missing or invalid)'
}

# ---------------------------------------------------------- context weight
Banner 'context weight'
$ctxFiles = @(
    (Join-Path $sd 'CLAUDE.md'),
    (Join-Path $proj 'CLAUDE.md'),
    (Join-Path $proj 'AGENTS.md')
)
foreach ($f in $ctxFiles) {
    $label = $f.Replace($homeDir, '~')
    if (Test-Path -LiteralPath $f) {
        $kb = [math]::Round((Get-Item -LiteralPath $f).Length / 1kb, 1)
        if ((Get-Item -LiteralPath $f).Length -gt 40kb) { Warn "$label is large ($kb KB); trim derivable content" }
        else { Ok "$label ($kb KB)" }
    } else {
        Info "$label absent"
    }
}

# ------------------------------------------------------- skills and agents
Banner 'skills and agents'
$skillsDir = Join-Path $sd 'skills'
if (Test-Path -LiteralPath $skillsDir) {
    $dirs = Get-ChildItem $skillsDir -Directory -ErrorAction SilentlyContinue
    foreach ($d in $dirs) {
        $md = Get-ChildItem $d.FullName -Filter '*.md' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($md) { Ok "~/.claude/skills/$($d.Name) (SKILL.md)" }
        else { Warn "~/.claude/skills/$($d.Name) has no .md (dead skill dir)" }
    }
} else { Info 'no user skills installed' }

if ($j -and $j.skillUsage) {
    $rows = @($j.skillUsage.PSObject.Properties | Sort-Object { [int]$_.Value.usageCount } -Descending)
    Info ("lifetime skill usage: " + (($rows | ForEach-Object { "{0}[{1}]" -f $_.Name, $_.Value.usageCount }) -join '  '))
}
foreach ($ad in @((Join-Path $sd 'agents'), (Join-Path $proj '.claude\agents'))) {
    $label = $ad.Replace($homeDir, '~')
    if (-not (Test-Path -LiteralPath $ad)) { Info "$label : not present"; continue }
    $items = Get-ChildItem $ad -ErrorAction SilentlyContinue
    $count = 0
    foreach ($it in $items) {
        if ($it.PSIsContainer) {
            $mds = @(Get-ChildItem $it.FullName -Filter '*.md' -ErrorAction SilentlyContinue)
            if ($mds.Count -gt 0) { Ok "$label\$($it.Name)\ ($($mds.Count) agents)"; $count += $mds.Count }
            else { Warn "$label\$($it.Name)\ EMPTY directory" }
        } elseif ($it.Extension -eq '.md') { Ok "$($it.FullName)"; $count++ }
        else { Warn "$($it.FullName): not .md; Claude Code loads only *.md agents" }
    }
    if ($count -eq 0) { Info "$label : no agent files" }
}

# ------------------------------------------------------------------ proxy
Banner 'm365 proxy'
if ($s -and $s.env -and $s.env.ANTHROPIC_BASE_URL) {
    $base = $s.env.ANTHROPIC_BASE_URL
    try {
        $resp = Invoke-WebRequest -Uri ($base + '/v1/models') -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        Ok "proxy responding at $base (HTTP $($resp.StatusCode))"
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code) { Ok "proxy responding at $base (HTTP $code)" }
        else { Warn "proxy unreachable at $base (Claude Code will fail to reach a model)"; Hint 'start the m365-copilot proxy, or unset ANTHROPIC_BASE_URL for direct mode' }
    }
} else {
    Info 'no ANTHROPIC_BASE_URL configured (direct API mode)'
}

# ------------------------------------------------------------- transcripts
Banner 'transcripts'
$tdir = Join-Path $sd 'projects'
if (Test-Path -LiteralPath $tdir) {
    $files = @(Get-ChildItem $tdir -Recurse -Filter '*.jsonl' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    $totalMb = [math]::Round(($files | Measure-Object Length -Sum).Sum / 1mb, 1)
    Info "$($files.Count) session transcripts, $totalMb MB total"
    foreach ($f in ($files | Select-Object -First 3)) {
        Info ("{0}  {1,5:N0} KB  {2}" -f $f.LastWriteTime.ToString('MM-dd HH:mm'), ($f.Length / 1kb), $f.Name)
    }
} else { Info 'no transcripts directory' }

# -------------------------------------------------------- project settings
Banner 'project settings'
foreach ($name in @('settings.json', 'settings.local.json', '.mcp.json')) {
    $p = Join-Path $proj $name
    if (Test-Path -LiteralPath $p) {
        try { $null = [IO.File]::ReadAllText($p) | ConvertFrom-Json; Ok "$name valid JSON" }
        catch { Warn "$name INVALID JSON: $($_.Exception.Message)" }
    } else {
        Info "$name absent"
    }
}

# ----------------------------------------------------------------- summary
$t0.Stop()
$el = [math]::Round($t0.Elapsed.TotalSeconds, 1)
Write-Host ''
Write-Host ('=' * $W)
Write-Host (" RESULT: $nOK ok | $nWarn warn | $nFail fail | $nInfo info   ($el s)") -ForegroundColor White
$checks = $nOK + $nWarn + $nFail
$pct = 0; if ($checks -gt 0) { $pct = [int][math]::Round(100 * $nOK / $checks) }
$filled = [int][math]::Round($pct / 10)
if ($filled -gt 10) { $filled = 10 }
$gaugeColor = 'Green'; if ($nFail -gt 0) { $gaugeColor = 'Red' } elseif ($nWarn -gt 0) { $gaugeColor = 'Yellow' }
Write-Host (' HEALTH [' + ('|' * $filled) + ('.' * (10 - $filled)) + "] $pct%") -ForegroundColor $gaugeColor
$exit = 0
if ($nFail -gt 0) { Write-Host ' VERDICT: broken - fix the [FAIL] items above' -ForegroundColor Red; $exit = 2 }
elseif ($nWarn -gt 0) { Write-Host ' VERDICT: usable - the [WARN] items above deserve attention' -ForegroundColor Yellow; $exit = 1 }
else { Write-Host ' VERDICT: healthy' -ForegroundColor Green }
Write-Host ('=' * $W)
exit $exit
