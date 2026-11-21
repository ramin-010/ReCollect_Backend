<#
.SYNOPSIS
  The connector simulation's hour (MCP_MEMORY_PLAN stage 5): a test backend on its own database, the app's own
  sign-in pages for it, and a temporary public tunnel to it. Development only; production is never touched.

.DESCRIPTION
  -Start [-Cloudflared <path to cloudflared.exe>]
      Starts, hidden, in this order:
        1. the tunnel (only with -Cloudflared): a Cloudflare quick tunnel to the test backend (no account; a new
           random https address at each start, read from its log);
        2. the test backend on 8012 (live editing on 1244) on the database recollect_connector_sim, with the
           remote door's trace on, sign-in for claude.ai and ChatGPT, signup closed, email delivery off and the AI
           off for every account (AI_ALLOWED_EMAILS names no one: the record needs no AI);
        3. the sign-in frontend on 3015: the app's own consent and login pages, talking to 8012 (a second Next dev
           server, building into recollect\.next\sim).
      Without -Cloudflared the backend names http://localhost:8012 as its address (the local check).
  -Stop    stops the three, puts back the two files the second Next server rewrites when it starts (tsconfig.json's
           include list and next-env.d.ts) and removes its build folder.
  -Status  shows each, and the public address.
  -RestartBackend  the test backend alone, with the same address (after mcp\dist-next is rebuilt for a wording change).
  -Report  runs grade.ts report on the trace, against the simulation database.

  Logs: backend\.devdb\logs\connector-{tunnel,backend,frontend}.log. The trace: backend\.devdb\connector\trace.jsonl.
  Run (PowerShell, from backend\):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sim\connector\hour.ps1 -Start [-Cloudflared <exe>]
#>
param(
    [switch]$Start,
    [switch]$Stop,
    [switch]$Status,
    [switch]$Report,
    [switch]$RestartBackend,
    [string]$Cloudflared = ''
)

$ErrorActionPreference = 'Stop'
$backendDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$rootDir = Split-Path -Parent $backendDir
$frontendDir = Join-Path $rootDir 'recollect'
$logDir = Join-Path $backendDir '.devdb\logs'
$stateDir = Join-Path $backendDir '.devdb\connector'
New-Item -ItemType Directory -Force -Path $logDir, $stateDir | Out-Null

$BackendPort = 8012
$CollabPort = 1244
$FrontendPort = 3015
$distDir = '.next/sim'                                  # inside .next, so already git-ignored
$distPath = Join-Path $frontendDir '.next\sim'
$trace = Join-Path $stateDir 'trace.jsonl'
$urlFile = Join-Path $stateDir 'public-url.txt'
$snapshots = @('tsconfig.json', 'next-env.d.ts')        # what the second Next server rewrites at its start

function Write-Step([string]$Text) { Write-Host ('[connector] {0}' -f $Text) }

function Get-Listeners([int[]]$Ports) {
    @(Get-NetTCPConnection -State Listen -LocalPort $Ports -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-CommandLine([int]$ProcessId) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if ($proc) { return [string]$proc.CommandLine }
    return ''
}

function Wait-Port([int]$Port, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if ((Get-Listeners @($Port)).Count -gt 0) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# The log's text since its last start marker.
function Get-LogTail([string]$Log) {
    if (-not (Test-Path $Log)) { return '' }
    $text = [string](Get-Content -Path $Log -Raw -ErrorAction SilentlyContinue)
    $at = $text.LastIndexOf('==== ')
    if ($at -lt 0) { return $text }
    return $text.Substring($at)
}

function Wait-Log([string]$Log, [string]$Pattern, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $m = [regex]::Match((Get-LogTail $Log), $Pattern)
        if ($m.Success) { return $m.Value }
        Start-Sleep -Milliseconds 700
    }
    return $null
}

# The dev database's address with the simulation database's name (never printed).
function Get-SimDatabaseUrl {
    $line = Get-Content (Join-Path $backendDir '.env') | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
    if (-not $line) { throw 'DATABASE_URL is not in backend\.env' }
    $value = ($line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
    $sim = $value -replace '^(postgres(?:ql)?://[^/]+/)[^?]*', '${1}recollect_connector_sim'
    if ($sim -notmatch '^postgres(?:ql)?://[^/]+/recollect_connector_sim(\?|$)') { throw 'could not point DATABASE_URL at recollect_connector_sim' }
    return $sim
}

# Starts a command hidden, its output appended to a log, with these environment variables for it alone.
function Start-Hidden([string]$Name, [string]$Command, [string]$Dir, [hashtable]$Vars) {
    $log = Join-Path $logDir ('connector-{0}.log' -f $Name)
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
        Move-Item -Force -Path $log -Destination (Join-Path $logDir ('connector-{0}.old.log' -f $Name))
    }
    Add-Content -Path $log -Value ('==== {0}  {1} ====' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Name)
    $saved = @{}
    foreach ($key in $Vars.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$Vars[$key], 'Process')
    }
    try {
        $cmdArgs = '/d /c "{0} >> "{1}" 2>&1"' -f $Command, $log
        Start-Process -FilePath $env:ComSpec -ArgumentList $cmdArgs -WorkingDirectory $Dir -WindowStyle Hidden | Out-Null
    } finally {
        foreach ($key in $Vars.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
    }
    return $log
}

function Stop-Ids([string]$Name, [int[]]$Ids) {
    foreach ($procId in $Ids) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Write-Step ('{0}: stopped process {1}' -f $Name, $procId)
    }
}

# Processes whose command line matches, by executable name.
function Get-ByCommandLine([string]$Exe, [string]$Pattern) {
    @(Get-CimInstance Win32_Process -Filter "Name='$Exe'" -ErrorAction SilentlyContinue |
        Where-Object { [string]$_.CommandLine -match $Pattern } |
        Select-Object -ExpandProperty ProcessId)
}

# Only listeners whose command line matches are stopped: nothing else that holds a port is touched.
function Get-OwnListeners([string]$Name, [int[]]$Ports, [string]$Pattern) {
    $ids = @()
    foreach ($procId in @(Get-Listeners $Ports)) {
        if ((Get-CommandLine $procId) -match $Pattern) { $ids += $procId }
        else { Write-Step ('{0}: left alone: a port is held by process {1}' -f $Name, $procId) }
    }
    return $ids
}

function Start-Backend([string]$PublicUrl, [string]$SimUrl, [string]$Embedded) {
    $blog = Start-Hidden 'backend' 'node node_modules\ts-node\dist\bin.js --transpile-only src/index.ts' $backendDir @{
        PORT                   = [string]$BackendPort
        COLLAB_PORT            = [string]$CollabPort
        DATABASE_URL           = $SimUrl
        RECOLLECT_SELF_URL     = $PublicUrl
        FRONTEND_URL           = ('http://localhost:{0}' -f $FrontendPort)
        ALLOWED_ORIGINS        = ('http://localhost:{0}' -f $FrontendPort)
        OAUTH_CIMD_HOSTS       = 'claude.ai,chatgpt.com'
        MCP_TRACE_FILE         = $trace
        RECOLLECT_MCP_EMBEDDED = $Embedded
        EMAIL_DELIVERY         = 'off'
        REMINDER_EMAIL         = 'off'
        SIGNUP_MODE            = 'closed'
        AI_ALLOWED_EMAILS      = 'no-one@connector-sim.invalid'
    }
    if (-not (Wait-Port $BackendPort 120)) { throw ('the test backend did not start in 120 s; see {0}' -f $blog) }
    Write-Step ('backend: http://localhost:{0} (database recollect_connector_sim; address {1}; log {2})' -f $BackendPort, $PublicUrl, $blog)
}

function Restore-Snapshots([bool]$Forget) {
    foreach ($f in $snapshots) {
        $copy = Join-Path $stateDir ('snapshot.' + $f)
        $file = Join-Path $frontendDir $f
        if (-not (Test-Path $copy)) { continue }
        if (-not (Test-Path $file) -or (Get-FileHash $copy).Hash -ne (Get-FileHash $file).Hash) {
            Copy-Item -Force -Path $copy -Destination $file
            Write-Step ('frontend: put back recollect\{0}' -f $f)
        }
        if ($Forget) { Remove-Item -Force -Path $copy }
    }
}

if ($Status) {
    $show = @(
        @{ Name = 'backend'; Ports = @($BackendPort, $CollabPort) },
        @{ Name = 'frontend'; Ports = @($FrontendPort) }
    )
    foreach ($s in $show) {
        $ids = @(Get-Listeners $s.Ports)
        if ($ids.Count -gt 0) { Write-Host ('{0,-9} running  ports {1}  process {2}' -f $s.Name, ($s.Ports -join ','), ($ids -join ',')) }
        else { Write-Host ('{0,-9} stopped' -f $s.Name) }
    }
    $tunnelIds = @(Get-ByCommandLine 'cloudflared.exe' ('localhost:{0}' -f $BackendPort))
    if ($tunnelIds.Count -gt 0) { Write-Host ('tunnel    running  process {0}' -f ($tunnelIds -join ',')) } else { Write-Host 'tunnel    stopped' }
    if (Test-Path $urlFile) { Write-Host ('address   {0}  (MCP: {0}/mcp)' -f (Get-Content -Raw $urlFile).Trim()) }
    Write-Host ('logs: {0}\connector-*.log  trace: {1}' -f $logDir, $trace)
    return
}

if ($Stop) {
    $front = @(Get-OwnListeners 'frontend' @($FrontendPort) 'next[\\/]dist')
    $front += @(Get-ByCommandLine 'node.exe' ('next[\\/]dist[\\/]bin[\\/]next\S*\s+dev\s+-p\s+{0}\b' -f $FrontendPort))
    Stop-Ids 'frontend' @($front | Select-Object -Unique)
    Stop-Ids 'backend' @(Get-OwnListeners 'backend' @($BackendPort, $CollabPort) 'src[\\/]index\.ts')
    Stop-Ids 'tunnel' @(Get-ByCommandLine 'cloudflared.exe' ('localhost:{0}' -f $BackendPort))
    Start-Sleep -Seconds 2
    Restore-Snapshots $true
    if ((Test-Path $distPath) -and ($distPath -match '\\recollect\\\.next\\sim$')) {
        Remove-Item -Recurse -Force -Path $distPath -ErrorAction SilentlyContinue
        Write-Step 'frontend: removed recollect\.next\sim'
    }
    if (Test-Path $urlFile) { Remove-Item -Force -Path $urlFile }
    Write-Step 'stopped'
    return
}

if ($Report) {
    $saved = [Environment]::GetEnvironmentVariable('DATABASE_URL', 'Process')
    [Environment]::SetEnvironmentVariable('DATABASE_URL', (Get-SimDatabaseUrl), 'Process')
    try {
        Push-Location $backendDir
        & node node_modules\ts-node\dist\bin.js --transpile-only scripts\sim\connector\grade.ts report $trace
    } finally {
        Pop-Location
        [Environment]::SetEnvironmentVariable('DATABASE_URL', $saved, 'Process')
    }
    return
}

if ($RestartBackend) {
    # After a wording change (mcp\dist-next rebuilt): the backend alone, with the same public address, so the
    # connectors already added in claude.ai and ChatGPT keep working (their sign-ins live in the database).
    if (-not (Test-Path $urlFile)) { throw 'no public address recorded: use -Start' }
    Stop-Ids 'backend' @(Get-OwnListeners 'backend' @($BackendPort, $CollabPort) 'src[\\/]index\.ts')
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Listeners @($BackendPort, $CollabPort)).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    Start-Backend (Get-Content -Raw $urlFile).Trim() (Get-SimDatabaseUrl) (($rootDir -replace '\\', '/') + '/mcp/dist-next/embedded.js')
    return
}

if (-not $Start) {
    Write-Host 'Use -Start [-Cloudflared <exe>], -Stop, -Status, -RestartBackend or -Report.'
    return
}

$held = @(Get-Listeners @($BackendPort, $CollabPort, $FrontendPort))
if ($held.Count -gt 0) { throw ('a port of {0}, {1} or {2} is in use (process {3}): run -Status or -Stop first' -f $BackendPort, $CollabPort, $FrontendPort, ($held -join ', ')) }
$embedded = ($rootDir -replace '\\', '/') + '/mcp/dist-next/embedded.js'
if (-not (Test-Path $embedded)) { throw 'mcp\dist-next is not built (in mcp\: npx tsc -p tsconfig.json --outDir dist-next)' }
$simUrl = Get-SimDatabaseUrl

# 1. The tunnel, and its public address.
$publicUrl = 'http://localhost:{0}' -f $BackendPort
if ($Cloudflared) {
    if (-not (Test-Path $Cloudflared)) { throw ('cloudflared not found: {0}' -f $Cloudflared) }
    $tlog = Start-Hidden 'tunnel' ('"{0}" tunnel --no-autoupdate --url http://localhost:{1}' -f $Cloudflared, $BackendPort) $stateDir @{}
    $found = Wait-Log $tlog 'https://[a-z0-9-]+\.trycloudflare\.com' 90
    if (-not $found) { throw ('the tunnel gave no address in 90 s; see {0}' -f $tlog) }
    $publicUrl = $found
    Write-Step ('tunnel: {0}' -f $publicUrl)
}
Set-Content -Path $urlFile -Value $publicUrl -Encoding ascii

# 2. The test backend.
Start-Backend $publicUrl $simUrl $embedded

# 3. The sign-in frontend. The two files Next rewrites at its start are kept first, and put back once it is ready.
foreach ($f in $snapshots) {
    $copy = Join-Path $stateDir ('snapshot.' + $f)
    if (-not (Test-Path $copy)) { Copy-Item -Path (Join-Path $frontendDir $f) -Destination $copy }
}
$flog = Start-Hidden 'frontend' ('node node_modules\next\dist\bin\next dev -p {0}' -f $FrontendPort) $frontendDir @{
    NEXT_DIST_DIR            = $distDir
    NEXT_PUBLIC_BACKEND_URL  = ('http://localhost:{0}' -f $BackendPort)
    NEXT_PUBLIC_FRONTEND_URL = ('http://localhost:{0}' -f $FrontendPort)
    NEXT_PUBLIC_COLLAB_URL   = ('ws://localhost:{0}' -f $CollabPort)
}
if (-not (Wait-Port $FrontendPort 120)) { throw ('the sign-in frontend did not start in 120 s; see {0}' -f $flog) }
$ready = Wait-Log $flog 'Ready in' 90
Start-Sleep -Seconds 3
Restore-Snapshots $false
if (-not $ready) { Write-Step ('frontend: no "Ready" line yet; see {0}' -f $flog) }
Write-Step ('frontend: http://localhost:{0} (log {1})' -f $FrontendPort, $flog)
Write-Step ('the connector address: {0}/mcp' -f $publicUrl)
Write-Step ('the trace: {0}' -f $trace)
