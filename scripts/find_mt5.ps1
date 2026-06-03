$candidates = @(
  "$env:ProgramFiles\MetaTrader 5\terminal64.exe",
  "${env:ProgramFiles(x86)}\MetaTrader 5\terminal64.exe",
  "$env:LOCALAPPDATA\Programs\MetaTrader 5\terminal64.exe"
)

$found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $found) {
  $found = Get-ChildItem -Path "$env:ProgramFiles", "${env:ProgramFiles(x86)}", "$env:LOCALAPPDATA" -Filter terminal64.exe -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}

if ($found) {
  "MT5_TERMINAL_PATH=$found"
} else {
  "MT5 terminal64.exe not found. Set MT5_TERMINAL_PATH manually in .env"
}
