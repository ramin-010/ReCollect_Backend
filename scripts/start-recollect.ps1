<#
  Recollect on this PC: starts the dev database (:5433), the backend (:8002, live editing :1234)
  and the frontend (:3005). Each starts only when nothing listens on its ports, so a second run
  starts nothing, and servers started some other way are left alone. (SYNC_SPINE_SPEC 0.2)

    npm run up                       (in backend/) start whatever is not running
    npm run up -- -Status            what runs, with process ids and the log folder
    npm run up -- -Restart backend   stop the backend and start it again (after backend changes)
    npm run up -- -Stop frontend     stop it (db, backend, frontend; the database stops cleanly)

  Or directly: powershell -NoProfile -ExecutionPolicy Bypass -File backend\scripts\start-recollect.ps1
  Windows are hidden. Each server appends to backend\.devdb\logs\<name>.log, and this script
  writes what it did to backend\.devdb\logs\start.log. install-autostart.ps1 runs it at logon.
  Once a day it also makes a local backup of the database (scripts\db-dump.mjs, backend\.devdb\dumps).
  Keep this file ASCII: Windows PowerShell 5.1 reads a file without a BOM as ANSI.
#>
[CmdletBinding()]
param(
    [ValidateSet('db', 'backend', 'frontend')][string[]]$Restart = @(),
    [ValidateSet('db', 'backend', 'frontend')][string[]]$Stop = @(),
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$backendDir = Split-Path -Parent $PSScriptRoot
$rootDir = Split-Path -Parent $backendDir
$logDir = Join-Path $backendDir '.devdb\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Ports, the folder each server runs in, its command, and a pattern its process command line must
# match before this script stops it (nothing else that happens to hold a port is ever touched).
$services = [ordered]@{
    db       = @{ Ports = @(5433);       Dir = $backendDir;                      Command = 'npm run db:start';    Match = '\.devdb\\data';     WaitSec = 90 }
    backend  = @{ Ports = @(8002, 1234); Dir = $backendDir;                      Command = 'npm run start:local'; Match = 'src[\\/]index\.ts'; WaitSec = 90 }
    frontend = @{ Ports = @(3005);       Dir = (Join-Path $rootDir 'recollect'); Command = 'npm run dev';         Match = 'next[\\/]dist';     WaitSec = 120 }
}

function Write-Log([string]$Text) {
    Write-Host $Text
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
    Add-Content -Path (Join-Path $logDir 'start.log') -Value $line
}

# Process ids listening on any of these ports (IPv4 or IPv6).
function Get-Listeners([int[]]$Ports) {
    @(Get-NetTCPConnection -State Listen -LocalPort $Ports -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-HeldPorts($svc) {
    @($svc.Ports | Where-Object { (Get-Listeners @($_)).Count -gt 0 })
}

function Get-CommandLine([int]$ProcessId) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if ($proc) { return [string]$proc.CommandLine }
    return ''
}

function Wait-Port([int]$Port, [int]$Seconds, [bool]$Free = $false) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $listening = (Get-Listeners @($Port)).Count -gt 0
        if ($listening -ne $Free) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Start-One([string]$Name) {
    $svc = $services[$Name]
    $held = @(Get-HeldPorts $svc)
    if ($held.Count -eq $svc.Ports.Count) {
        Write-Log ('{0}: already running (port {1})' -f $Name, ($svc.Ports -join ', '))
        return $false
    }
    if ($held.Count -gt 0) {
        Write-Log ('{0}: NOT started: port {1} is held by another process (see -Status)' -f $Name, ($held -join ', '))
        return $false
    }
    $log = Join-Path $logDir ('{0}.log' -f $Name)
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
        Move-Item -Force -Path $log -Destination (Join-Path $logDir ('{0}.old.log' -f $Name))
    }
    Add-Content -Path $log -Value ('==== {0}  {1} ====' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $svc.Command)
    # cmd keeps the output in the log; -WindowStyle Hidden gives it its own hidden console, so
    # closing the terminal that ran this script doesn't stop the server.
    $cmdArgs = '/d /c "{0} >> "{1}" 2>&1"' -f $svc.Command, $log
    Start-Process -FilePath $env:ComSpec -ArgumentList $cmdArgs -WorkingDirectory $svc.Dir -WindowStyle Hidden | Out-Null
    Write-Log ('{0}: started ({1}; log {2})' -f $Name, $svc.Command, $log)
    return $true
}

# The process ids -Restart stopped, per server, to prove after the start that the old one is gone.
$stoppedIds = @{}

# Stops a server; returns $true when its ports are free afterwards (a restart starts it only then).
function Stop-One([string]$Name) {
    $svc = $services[$Name]
    $ids = @()
    if ($Name -eq 'db') {
        if ((Get-Listeners $svc.Ports).Count -gt 0) {
            # A clean stop, with the same binaries the embedded server runs.
            $pgCtl = Join-Path $backendDir 'node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe'
            $data = Join-Path $backendDir '.devdb\data'
            $saved = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            $out = (& $pgCtl stop -D $data -m fast -w -t 30 2>&1 | Out-String).Trim()
            $ErrorActionPreference = $saved
            Write-Log ('db: pg_ctl stop: {0}' -f ($out -replace '\s+', ' '))
        }
        # The node process that started it (npm run db:start) waits forever: end it too.
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
            Where-Object { $_.CommandLine -match 'dev-db\.mjs' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    foreach ($procId in @(Get-Listeners $svc.Ports)) {
        $cmd = Get-CommandLine $procId
        if ($cmd -notmatch $svc.Match) {
            Write-Log ('{0}: left alone: its port is held by process {1} ({2})' -f $Name, $procId, $cmd)
            continue
        }
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        $ids += $procId
        Write-Log ('{0}: stopped process {1}' -f $Name, $procId)
    }
    $script:stoppedIds[$Name] = $ids
    $held = @()
    foreach ($port in $svc.Ports) {
        if (-not (Wait-Port $port 15 $true)) { $held += $port }
    }
    if ($held.Count -gt 0) {
        Write-Log ('{0}: port {1} is still held after 15 s (see -Status)' -f $Name, ($held -join ', '))
        return $false
    }
    if ($ids.Count -gt 0) { Write-Log ('{0}: port {1} free' -f $Name, ($svc.Ports -join ', ')) }
    return $true
}

if ($Status) {
    foreach ($name in $services.Keys) {
        $svc = $services[$name]
        $ids = @(Get-Listeners $svc.Ports)
        if ($ids.Count -gt 0) {
            Write-Host ('{0,-9} running  ports {1}  process {2}' -f $name, ((Get-HeldPorts $svc) -join ','), ($ids -join ','))
        } else {
            Write-Host ('{0,-9} stopped' -f $name)
        }
    }
    Write-Host ('logs: {0}' -f $logDir)
    return
}

foreach ($name in $Stop) { $null = Stop-One $name }
if ($Stop.Count -gt 0 -and $Restart.Count -eq 0) { return }
# A restart starts a server again only once its old process is gone and its ports are free; else
# it says so (never "already running" with the old code still serving).
$blocked = @{}
foreach ($name in $Restart) {
    if (-not (Stop-One $name)) {
        $blocked[$name] = $true
        Write-Log ('{0}: NOT restarted: its port is still held' -f $name)
    }
}

$started = @{}
$started['db'] = if ($blocked['db']) { $false } else { Start-One 'db' }
if ($started['db'] -and -not (Wait-Port 5433 $services['db'].WaitSec)) {
    Write-Log ('db: not listening after {0} s (see db.log)' -f $services['db'].WaitSec)
}
# One local backup a day (LOOP_COMPLETE_SPEC S1.2): only when today's is missing, in the background.
if ((Get-Listeners @(5433)).Count -gt 0) {
    $dumpLog = Join-Path $logDir 'dump.log'
    $dumpArgs = '/d /c "node scripts\db-dump.mjs --daily >> "{0}" 2>&1"' -f $dumpLog
    Start-Process -FilePath $env:ComSpec -ArgumentList $dumpArgs -WorkingDirectory $backendDir -WindowStyle Hidden | Out-Null
}
# The backend starts after the database: it runs a query at start.
$started['backend'] = if ($blocked['backend']) { $false } else { Start-One 'backend' }
$started['frontend'] = if ($blocked['frontend']) { $false } else { Start-One 'frontend' }
foreach ($name in @('backend', 'frontend')) {
    if (-not $started[$name]) { continue }
    $port = $services[$name].Ports[0]
    if (Wait-Port $port $services[$name].WaitSec) {
        $now = @(Get-Listeners $services[$name].Ports)
        $old = @($stoppedIds[$name] | Where-Object { $_ })
        if ($old.Count -eq 0) {
            Write-Log ('{0}: listening on {1}' -f $name, $port)
        } elseif (@($now | Where-Object { $old -contains $_ }).Count -gt 0) {
            Write-Log ('{0}: WARNING: the old process {1} still listens' -f $name, ($old -join ', '))
        } else {
            Write-Log ('{0}: listening on {1}: new process {2}, the old {3} is gone' -f $name, $port, ($now -join ', '), ($old -join ', '))
        }
    } else {
        Write-Log ('{0}: not listening after {1} s (see {0}.log)' -f $name, $services[$name].WaitSec)
    }
}
