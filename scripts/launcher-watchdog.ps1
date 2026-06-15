$ErrorActionPreference = "SilentlyContinue"

param(
  [Parameter(Mandatory = $true)]
  [int]$LauncherPid,

  [Parameter(Mandatory = $true)]
  [string]$RootPath,

  [Parameter(Mandatory = $true)]
  [string]$BrowserProfileDir
)

function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId }
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }

  Stop-Process -Id $ProcessId -Force
}

function Stop-TraderProcesses {
  $escapedRoot = [regex]::Escape($RootPath)
  $processes = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -match $escapedRoot -and
    (
      $_.CommandLine -match "npm-cli\.js.*run dev" -or
      $_.CommandLine -match "npm-cli\.js.*run start" -or
      $_.CommandLine -match "next.*dev" -or
      $_.CommandLine -match "next.*start" -or
      $_.CommandLine -match "npm-cli\.js.*run worker" -or
      $_.CommandLine -match "tsx.*src[/\\]worker[/\\]live-runner\.ts"
    )
  }

  foreach ($process in $processes) {
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
Stop-TraderProcesses
