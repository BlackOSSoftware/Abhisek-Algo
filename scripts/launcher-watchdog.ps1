param(
  [Parameter(Mandatory = $true)]
  [int]$LauncherPid,

  [Parameter(Mandatory = $true)]
  [string]$RootPath,

  [Parameter(Mandatory = $true)]
  [string]$BrowserProfileDir
)

$ErrorActionPreference = "SilentlyContinue"

$RunDir = Join-Path $RootPath ".trader-run"
$ServerPidFile = Join-Path $RunDir "server.pids"
$WorkerPidFile = Join-Path $RunDir "worker.pids"
$WatchdogPidFile = Join-Path $RunDir "watchdog.pid"

function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId }
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }

  Stop-Process -Id $ProcessId -Force
}

function Stop-PidFileProcessTree {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  $ids = Get-Content -Path $Path | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
  foreach ($id in ($ids | Sort-Object -Descending)) {
    Stop-ProcessTree -ProcessId $id
  }
  Remove-Item -Path $Path -Force
}

function Stop-TraderProcesses {
  $escapedRoot = [regex]::Escape($RootPath)
  $processes = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "node.exe" -or $_.Name -eq "cmd.exe" -or $_.Name -eq "powershell.exe" -or $_.Name -eq "pwsh.exe") -and
    $_.CommandLine -match $escapedRoot -and
    (
      $_.CommandLine -match "npm-cli\.js.*run dev" -or
      $_.CommandLine -match "npm-cli\.js.*run start" -or
      $_.CommandLine -match "npm(\.cmd)?\s+run\s+start" -or
      $_.CommandLine -match "npm(\.cmd)?\s+run\s+worker" -or
      $_.CommandLine -match "next.*dev" -or
      $_.CommandLine -match "next.*start" -or
      $_.CommandLine -match "npm-cli\.js.*run worker" -or
      $_.CommandLine -match "tsx.*src[/\\]worker[/\\]live-runner\.ts"
    )
  }

  foreach ($process in $processes) {
    Stop-ProcessTree -ProcessId $process.ProcessId
  }

  $workerProcesses = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "node.exe" -or $_.Name -eq "cmd.exe") -and
    (
      $_.CommandLine -match "npm-cli\.js.*run worker" -or
      $_.CommandLine -match "npm(\.cmd)?\s+run\s+worker" -or
      $_.CommandLine -match "tsx\s+src[/\\]worker[/\\]live-runner\.ts" -or
      $_.CommandLine -match "live-runner\.ts"
    )
  }

  foreach ($process in $workerProcesses) {
    Stop-ProcessTree -ProcessId $process.ProcessId
  }

  $connections = Get-NetTCPConnection -LocalPort 3000 -State Listen
  foreach ($connection in $connections) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)"
    if ($process -and $process.Name -eq "node.exe" -and $process.CommandLine -match $escapedRoot) {
      Stop-ProcessTree -ProcessId $process.ProcessId
    }
  }
}

function Stop-TraderBrowser {
  $escapedProfile = [regex]::Escape($BrowserProfileDir)
  $browserProcesses = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "chrome.exe" -or $_.Name -eq "msedge.exe") -and
    $_.CommandLine -match $escapedProfile
  }

  foreach ($process in $browserProcesses) {
    Stop-ProcessTree -ProcessId $process.ProcessId
  }
}

while (Get-Process -Id $LauncherPid) {
  Start-Sleep -Seconds 1
}

Start-Sleep -Seconds 1
Stop-TraderBrowser
Stop-PidFileProcessTree -Path $WorkerPidFile
Stop-PidFileProcessTree -Path $ServerPidFile
Stop-TraderProcesses
Remove-Item -Path $WatchdogPidFile -Force
