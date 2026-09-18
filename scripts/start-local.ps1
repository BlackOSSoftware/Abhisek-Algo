$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$serverLog = Join-Path $root "server.log"
$serverErr = Join-Path $root "server.err.log"
$workerLog = Join-Path $root "worker.log"
$workerErr = Join-Path $root "worker.err.log"
$url = "http://localhost:3000"
$browserProfileDir = Join-Path $env:TEMP "grid-trader-pro-browser-profile"
$watchdogScript = Join-Path $PSScriptRoot "launcher-watchdog.ps1"
$runDir = Join-Path $root ".trader-run"
$serverPidFile = Join-Path $runDir "server.pids"
$workerPidFile = Join-Path $runDir "worker.pids"
$watchdogPidFile = Join-Path $runDir "watchdog.pid"
$databasePath = Join-Path $root "data\trader.sqlite"
$backupDir = Join-Path $root "data\backups"
$dependencyHashFile = Join-Path $runDir "package-lock.sha256"
$buildHashFile = Join-Path $runDir "production-build.sha256"

function Invoke-RequiredCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$Description
  )

  Write-Host $Description -ForegroundColor Cyan
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed (exit code $LASTEXITCODE)."
  }
}

function Test-CommandAvailable {
  param([string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Backup-TraderDatabase {
  if (-not (Test-Path $databasePath)) {
    return
  }

  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = Join-Path $backupDir "trader-$stamp.sqlite"
  Copy-Item -LiteralPath $databasePath -Destination $backupPath -ErrorAction Stop
  Get-ChildItem -Path $backupDir -Filter "trader-*.sqlite" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 14 |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Write-Host "Database backup created: $backupPath" -ForegroundColor DarkGray
}

function Update-ProjectCode {
  if (-not (Test-CommandAvailable "git")) {
    Write-Host "Git not found; using the local project copy." -ForegroundColor Yellow
    return
  }

  $repoCheck = & git rev-parse --is-inside-work-tree 2>$null
  if ($LASTEXITCODE -ne 0 -or $repoCheck -ne "true") {
    Write-Host "Not a Git repository; skipping code update." -ForegroundColor Yellow
    return
  }

  $changes = @(& git status --porcelain --untracked-files=no)
  if ($changes.Count -gt 0) {
    Write-Host "Local code changes found; skipping Git pull to protect your work." -ForegroundColor Yellow
    $changes | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    return
  }

  Write-Host "Checking for latest GitHub code..." -ForegroundColor Cyan
  & git fetch --prune origin
  if ($LASTEXITCODE -ne 0) {
    Write-Host "GitHub could not be reached; continuing with the local code copy." -ForegroundColor Yellow
    return
  }
  $behind = [int](& git rev-list --count "HEAD..@{u}")
  if ($LASTEXITCODE -ne 0) {
    Write-Host "No upstream branch configured; skipping Git pull." -ForegroundColor Yellow
    return
  }
  if ($behind -gt 0) {
    Invoke-RequiredCommand -FilePath "git" -Arguments @("pull", "--ff-only") -Description "Downloading latest code..."
  } else {
    Write-Host "Code is already up to date." -ForegroundColor Green
  }
}

function Ensure-NodeDependencies {
  $lockFile = Join-Path $root "package-lock.json"
  if (-not (Test-Path $lockFile)) {
    throw "package-lock.json is missing; dependencies cannot be installed safely."
  }

  New-Item -ItemType Directory -Path $runDir -Force | Out-Null
  $currentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $lockFile).Hash
  $savedHash = if (Test-Path $dependencyHashFile) { (Get-Content -LiteralPath $dependencyHashFile -Raw).Trim() } else { "" }
  $modulesPresent = Test-Path (Join-Path $root "node_modules")
  $dependenciesHealthy = $false
  if ($modulesPresent) {
    & npm.cmd ls --depth=0 --no-audit --no-fund *> $null
    $dependenciesHealthy = $LASTEXITCODE -eq 0
  }
  if (-not $modulesPresent -or -not $dependenciesHealthy -or $currentHash -ne $savedHash) {
    Invoke-RequiredCommand -FilePath "npm.cmd" -Arguments @("ci", "--no-audit", "--no-fund") -Description "Installing required Node dependencies..."
    Set-Content -LiteralPath $dependencyHashFile -Value $currentHash
  } else {
    Write-Host "Node dependencies are ready." -ForegroundColor Green
  }
}

function Ensure-Mt5PythonPackage {
  $envFile = Join-Path $root ".env"
  $liveTrading = $false
  if (Test-Path $envFile) {
    $liveTrading = (Select-String -LiteralPath $envFile -Pattern '^\s*LIVE_TRADING_ENABLED\s*=\s*true\s*$' -Quiet)
  }
  if (-not $liveTrading) {
    Write-Host "Live trading is disabled; MT5 package check skipped." -ForegroundColor DarkGray
    return
  }

  $python = if (Test-CommandAvailable "python") { "python" } else { throw "Python is required for the MT5 worker but was not found." }
  & $python -c "import MetaTrader5" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Invoke-RequiredCommand -FilePath $python -Arguments @("-m", "pip", "install", "MetaTrader5") -Description "Installing missing MetaTrader5 Python package..."
  }
}

function Get-ProjectBuildHash {
  $hashInputs = New-Object System.Collections.Generic.List[string]
  $rootPath = $root.Path
  $trackedFiles = @(
    ".env",
    ".env.local",
    "package-lock.json",
    "package.json",
    "next.config.ts",
    "tsconfig.json",
    "tailwind.config.ts",
    "postcss.config.mjs"
  )

  foreach ($relativePath in $trackedFiles) {
    $path = Join-Path $rootPath $relativePath
    if (Test-Path -LiteralPath $path) {
      $fileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
      $hashInputs.Add("$relativePath=$fileHash")
    }
  }

  foreach ($folder in @("src", "public")) {
    $folderPath = Join-Path $rootPath $folder
    if (-not (Test-Path -LiteralPath $folderPath)) {
      continue
    }

    Get-ChildItem -LiteralPath $folderPath -File -Recurse |
      Sort-Object FullName |
      ForEach-Object {
        $relativePath = $_.FullName.Substring($rootPath.Length + 1)
        $fileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
        $hashInputs.Add("$relativePath=$fileHash")
      }
  }

  $hashText = ($hashInputs | Sort-Object) -join "`n"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($hashText)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "")
  } finally {
    $sha.Dispose()
  }
}

function Ensure-ProjectBuild {
  New-Item -ItemType Directory -Path $runDir -Force | Out-Null
  $buildIdFile = Join-Path $root ".next\BUILD_ID"
  $currentHash = Get-ProjectBuildHash
  $savedHash = if (Test-Path $buildHashFile) { (Get-Content -LiteralPath $buildHashFile -Raw).Trim() } else { "" }

  if ((Test-Path -LiteralPath $buildIdFile) -and [string]::IsNullOrWhiteSpace($savedHash)) {
    Set-Content -LiteralPath $buildHashFile -Value $currentHash
    Write-Host "Existing production build found; reusing it." -ForegroundColor Green
    return
  }

  if ((Test-Path -LiteralPath $buildIdFile) -and $currentHash -eq $savedHash) {
    Write-Host "Production build is already ready." -ForegroundColor Green
    return
  }

  Invoke-RequiredCommand -FilePath "npm.cmd" -Arguments @("run", "typecheck") -Description "Checking TypeScript..."
  Invoke-RequiredCommand -FilePath "npm.cmd" -Arguments @("test", "--", "--test-concurrency=1") -Description "Running automated tests..."
  Invoke-RequiredCommand -FilePath "npm.cmd" -Arguments @("run", "build") -Description "Creating production build..."
  Set-Content -LiteralPath $buildHashFile -Value $currentHash
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId }
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Get-DescendantProcessIds {
  param([int]$ProcessId)

  $ids = @($ProcessId)
  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId }
  foreach ($child in $children) {
    $ids += Get-DescendantProcessIds -ProcessId $child.ProcessId
  }
  return $ids
}

function Save-ProcessTreeIds {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$Path
  )

  if (-not $Process) {
    return
  }

  New-Item -ItemType Directory -Path $runDir -Force | Out-Null
  Get-DescendantProcessIds -ProcessId $Process.Id | Sort-Object -Unique | Set-Content -Path $Path
}

function Stop-PidFileProcessTree {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  $ids = Get-Content -Path $Path -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
  foreach ($id in ($ids | Sort-Object -Descending)) {
    Stop-ProcessTree -ProcessId $id
  }
  Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue
}

function Stop-RecordedTraderProcesses {
  Stop-PidFileProcessTree -Path $workerPidFile
  Stop-PidFileProcessTree -Path $serverPidFile
  Stop-PidFileProcessTree -Path $watchdogPidFile
}

function Stop-ExistingTraderProcesses {
  $escapedRoot = [regex]::Escape($root.Path)
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
}

function Stop-OrphanTraderWorkerProcesses {
  $processes = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "node.exe" -or $_.Name -eq "cmd.exe") -and
    (
      $_.CommandLine -match "npm-cli\.js.*run worker" -or
      $_.CommandLine -match "npm(\.cmd)?\s+run\s+worker" -or
      $_.CommandLine -match "tsx\s+src[/\\]worker[/\\]live-runner\.ts" -or
      $_.CommandLine -match "live-runner\.ts"
    )
  }

  foreach ($process in $processes) {
    Stop-ProcessTree -ProcessId $process.ProcessId
  }
}

function Stop-LocalPortProcesses {
  param([int]$Port)

  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    if (
      $process -and
      $process.Name -eq "node.exe" -and
      $process.CommandLine -match [regex]::Escape($root.Path)
    ) {
      Stop-ProcessTree -ProcessId $process.ProcessId
    }
  }
}

function Stop-TraderServices {
  param(
    [System.Diagnostics.Process]$ServerProcess,
    [System.Diagnostics.Process]$WorkerProcess,
    [System.Diagnostics.Process]$BrowserProcess
  )

  Stop-TraderBrowser -BrowserProcess $BrowserProcess

  if ($ServerProcess) {
    Stop-ProcessTree -ProcessId $ServerProcess.Id
  }
  if ($WorkerProcess) {
    Stop-ProcessTree -ProcessId $WorkerProcess.Id
  }

  Stop-ExistingTraderProcesses
  Stop-OrphanTraderWorkerProcesses
  Stop-LocalPortProcesses -Port 3000
  Stop-RecordedTraderProcesses
}

function Find-ChromePath {
  $candidates = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  $command = Get-Command "chrome.exe" -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return $null
}

function Start-TraderBrowser {
  param([string]$TargetUrl)

  $chromePath = Find-ChromePath
  if (-not $chromePath) {
    Write-Host "Chrome not found. Opening default browser instead." -ForegroundColor Yellow
    Start-Process $TargetUrl
    return $null
  }

  New-Item -ItemType Directory -Path $browserProfileDir -Force | Out-Null
  $arguments = @(
    "--app=$TargetUrl",
    "--user-data-dir=$browserProfileDir",
    "--no-first-run",
    "--disable-session-crashed-bubble"
  )

  return Start-Process -FilePath $chromePath -ArgumentList $arguments -PassThru
}

function Stop-TraderBrowser {
  param([System.Diagnostics.Process]$BrowserProcess)

  $escapedProfile = [regex]::Escape($browserProfileDir)
  $browserProcesses = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "chrome.exe" -or $_.Name -eq "msedge.exe") -and
    $_.CommandLine -match $escapedProfile
  }

  foreach ($process in $browserProcesses) {
    Stop-ProcessTree -ProcessId $process.ProcessId
  }

  if ($BrowserProcess) {
    Stop-ProcessTree -ProcessId $BrowserProcess.Id
  }
}

function Test-TraderBrowserWindowOpen {
  $escapedProfile = [regex]::Escape($browserProfileDir)
  $browserProcesses = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "chrome.exe" -or $_.Name -eq "msedge.exe") -and
    $_.CommandLine -match $escapedProfile
  }

  foreach ($browserProcessInfo in $browserProcesses) {
    $process = Get-Process -Id $browserProcessInfo.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) {
      return $true
    }
  }

  return $false
}

function Wait-ForTraderShutdownSignal {
  param([System.Diagnostics.Process]$BrowserProcess)

  if (-not $BrowserProcess) {
    Read-Host | Out-Null
    return "manual"
  }

  $windowDeadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $windowDeadline -and -not (Test-TraderBrowserWindowOpen)) {
    Start-Sleep -Milliseconds 250
  }

  if (-not (Test-TraderBrowserWindowOpen)) {
    Write-Host "Browser window did not stay open; stopping the engine." -ForegroundColor Yellow
    return "browser"
  }

  while ($true) {
    try {
      if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq [ConsoleKey]::Enter) {
          return "manual"
        }
      }
    } catch {
      # The launcher normally has a console; browser monitoring still works without one.
    }

    if (-not (Test-TraderBrowserWindowOpen)) {
      Start-Sleep -Seconds 2
      if (-not (Test-TraderBrowserWindowOpen)) {
        return "browser"
      }
    }

    Start-Sleep -Milliseconds 500
  }
}

function Resolve-PowerShellExe {
  $candidates = @(
    (Join-Path $PSHOME "powershell.exe"),
    (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"),
    (Join-Path $env:SystemRoot "SysWOW64\WindowsPowerShell\v1.0\powershell.exe")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  $fromPath = Get-Command "powershell.exe" -ErrorAction SilentlyContinue
  if ($fromPath -and $fromPath.Source) {
    return $fromPath.Source
  }

  return $null
}

function Start-LauncherWatchdog {
  $powershellExe = Resolve-PowerShellExe
  if (-not $powershellExe) {
    Write-Host "Watchdog skipped: powershell.exe not found." -ForegroundColor Yellow
    return
  }

  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $watchdogScript,
    "-LauncherPid",
    $PID,
    "-RootPath",
    $root.Path,
    "-BrowserProfileDir",
    $browserProfileDir
  )

  try {
    $watchdog = Start-Process -FilePath $powershellExe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if ($watchdog) {
      New-Item -ItemType Directory -Path $runDir -Force | Out-Null
      Set-Content -Path $watchdogPidFile -Value $watchdog.Id
    }
  } catch {
    Write-Host "Watchdog skipped: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Wait-ForUrl {
  param(
    [string]$TargetUrl,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $TargetUrl -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return $true
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  return $false
}

function Show-LogTail {
  param(
    [string]$Title,
    [string]$Path,
    [int]$Lines = 40
  )

  Write-Host ""
  Write-Host $Title -ForegroundColor Yellow
  if (-not (Test-Path $Path)) {
    Write-Host "Log file not found: $Path" -ForegroundColor Yellow
    return
  }

  $content = Get-Content -Path $Path -Tail $Lines -ErrorAction SilentlyContinue
  if ($content) {
    $content | ForEach-Object { Write-Host $_ }
  } else {
    Write-Host "(empty)"
  }
}

function Test-StartedProcess {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$Name,
    [string]$ErrorLog,
    [int]$DelaySeconds = 5
  )

  Start-Sleep -Seconds $DelaySeconds
  $running = Get-Process -Id $Process.Id -ErrorAction SilentlyContinue
  if ($running) {
    Write-Host "$Name started. PID: $($Process.Id)" -ForegroundColor Green
    return $true
  }

  Write-Host "$Name stopped during startup." -ForegroundColor Red
  Show-LogTail -Title "$Name error log:" -Path $ErrorLog
  return $false
}

Set-Location $root

Write-Host ""
Write-Host "Grid Trader Pro local launcher" -ForegroundColor Cyan
Write-Host "Project: $root"
Write-Host ""

if (-not (Test-CommandAvailable "node") -or -not (Test-CommandAvailable "npm.cmd")) {
  throw "Node.js and npm are required. Install the current Node.js LTS version, then run Start Trader.cmd again."
}

Backup-TraderDatabase
Update-ProjectCode
Ensure-NodeDependencies
Ensure-Mt5PythonPackage
Ensure-ProjectBuild

Write-Host "Stopping old local dev/worker processes for this project..."
Stop-RecordedTraderProcesses
Stop-ExistingTraderProcesses
Stop-OrphanTraderWorkerProcesses
Stop-LocalPortProcesses -Port 3000
Start-Sleep -Seconds 2

"" | Set-Content -Path $serverLog
"" | Set-Content -Path $serverErr
"" | Set-Content -Path $workerLog
"" | Set-Content -Path $workerErr

Write-Host "Starting production dashboard..."
$serverProcess = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "start" -WorkingDirectory $root -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr -WindowStyle Hidden -PassThru
if (-not (Test-StartedProcess -Process $serverProcess -Name "Dashboard server" -ErrorLog $serverErr -DelaySeconds 4)) {
  Show-LogTail -Title "Server log:" -Path $serverLog
  Read-Host "Press ENTER to close" | Out-Null
  exit 1
}
Save-ProcessTreeIds -Process $serverProcess -Path $serverPidFile

Write-Host "Starting MT5 worker..."
$workerProcess = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "worker" -WorkingDirectory $root -RedirectStandardOutput $workerLog -RedirectStandardError $workerErr -WindowStyle Hidden -PassThru
if (-not (Test-StartedProcess -Process $workerProcess -Name "MT5 worker" -ErrorLog $workerErr -DelaySeconds 6)) {
  Show-LogTail -Title "Worker log:" -Path $workerLog
  Stop-TraderServices -ServerProcess $serverProcess -WorkerProcess $workerProcess -BrowserProcess $null
  Read-Host "Press ENTER to close" | Out-Null
  exit 1
}
Save-ProcessTreeIds -Process $workerProcess -Path $workerPidFile
Start-LauncherWatchdog

Write-Host "Waiting for dashboard: $url"
if (Wait-ForUrl -TargetUrl $url -TimeoutSeconds 90) {
  Write-Host "Dashboard ready. Opening browser..." -ForegroundColor Green
  $browserProcess = Start-TraderBrowser -TargetUrl $url
} else {
  Write-Host "Dashboard did not respond within 90 seconds. Check server.err.log." -ForegroundColor Yellow
  Show-LogTail -Title "Server error log:" -Path $serverErr
  Show-LogTail -Title "Server log:" -Path $serverLog
}

Write-Host ""
Write-Host "Running in one launcher window." -ForegroundColor Green
Write-Host "URL: $url"
Write-Host "Server log: $serverLog"
Write-Host "Worker log: $workerLog"
Write-Host ""
Write-Host "Close the Chrome app or press ENTER here to stop dashboard + worker safely."
$shutdownReason = Wait-ForTraderShutdownSignal -BrowserProcess $browserProcess
if ($shutdownReason -eq "browser") {
  Write-Host "Chrome closed. Stopping the complete trading engine..." -ForegroundColor Yellow
} else {
  Write-Host "Manual stop requested." -ForegroundColor Yellow
}

Write-Host "Stopping services..."
Stop-TraderServices -ServerProcess $serverProcess -WorkerProcess $workerProcess -BrowserProcess $browserProcess
Remove-Item -Path $serverPidFile, $workerPidFile, $watchdogPidFile -Force -ErrorAction SilentlyContinue
Write-Host "Stopped. You can close this window." -ForegroundColor Green
