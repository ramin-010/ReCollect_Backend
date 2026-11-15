<#
  Starts Recollect when you log on to Windows: a shortcut "Recollect" in your Startup folder runs
  start-recollect.ps1 with no window (conhost --headless). (SYNC_SPINE_SPEC 0.2)

    npm run autostart                (in backend/) add the shortcut
    npm run autostart -- -Remove     take it out again

  Switch it off any time in Task Manager > Startup apps ("Recollect"). A Startup shortcut, not a
  scheduled task: no admin rights, and the servers it starts are never tied to a task's lifetime.
  -Folder <dir> puts the shortcut somewhere else (for testing).
  Keep this file ASCII: Windows PowerShell 5.1 reads a file without a BOM as ANSI.
#>
[CmdletBinding()]
param(
    [switch]$Remove,
    [string]$Folder = [Environment]::GetFolderPath('Startup')
)

$ErrorActionPreference = 'Stop'
$link = Join-Path $Folder 'Recollect.lnk'

if ($Remove) {
    if (Test-Path $link) {
        Remove-Item -Path $link
        Write-Host ('Removed {0}. Recollect no longer starts at logon (servers running now keep running).' -f $link)
    } else {
        Write-Host ('Nothing to remove: {0} does not exist.' -f $link)
    }
    return
}

$script = Join-Path $PSScriptRoot 'start-recollect.ps1'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $conhost
$shortcut.Arguments = ('--headless "{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}"' -f $powershell, $script)
$shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'Starts Recollect (database, backend, frontend) at logon'
$shortcut.Save()

Write-Host ('Added {0}' -f $link)
Write-Host ('  runs: {0} {1}' -f $shortcut.TargetPath, $shortcut.Arguments)
Write-Host 'Recollect now starts at logon. Logs: backend\.devdb\logs\. Switch it off in Task Manager > Startup apps, or: npm run autostart -- -Remove'
