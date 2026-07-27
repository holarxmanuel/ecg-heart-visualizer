<#
    Real-Time ECG Heart Visualizer -- one-command launcher (Windows)

        .\start.ps1              normal start
        .\start.ps1 -Prod        serve the production build (lower CPU)
        .\start.ps1 -SkipSetup   skip dependency checks

    First run creates the Python venv and installs both dependency sets, which
    takes a few minutes. Subsequent runs start in seconds.

    If PowerShell refuses to run this, unblock scripts for this session only:
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#>

param(
    [switch]$Prod,
    [switch]$SkipSetup
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$venvPython = Join-Path $backend '.venv\Scripts\python.exe'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor DarkGray }

Write-Host @"
===============================================================
  Real-Time ECG Heart Visualizer
  Anatomical 3D heart - live ECG - synchronised heart sounds
===============================================================
"@ -ForegroundColor Red

# ---------------------------------------------------------------- prerequisites
Write-Step 'Checking prerequisites'

$py = $null
foreach ($candidate in @('3.13', '3.12')) {
    # py -0p lists installed interpreters; -3.12 selects one explicitly.
    & py "-$candidate" -c "import sys" 2>$null
    if ($LASTEXITCODE -eq 0) { $py = "-$candidate"; break }
}
if (-not $py) {
    Write-Host "Python 3.12+ not found. Install it from https://python.org and re-run." -ForegroundColor Red
    exit 1
}
Write-Ok "Python $($py.TrimStart('-')) found"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found. Install the LTS build from https://nodejs.org and re-run." -ForegroundColor Red
    exit 1
}
Write-Ok "Node $(node -v) found"

# ---------------------------------------------------------------------- setup
if (-not $SkipSetup) {
    if (-not (Test-Path $venvPython)) {
        Write-Step 'Creating Python virtual environment (first run only)'
        & py $py -m venv (Join-Path $backend '.venv')
    }

    Write-Step 'Installing backend dependencies'
    & $venvPython -m pip install --upgrade pip --quiet
    & $venvPython -m pip install -r (Join-Path $backend 'requirements.txt') --quiet
    Write-Ok 'Backend ready'

    if (-not (Test-Path (Join-Path $frontend 'node_modules'))) {
        Write-Step 'Installing frontend dependencies (first run only)'
        Push-Location $frontend
        npm install --no-fund --no-audit
        Pop-Location
    }
    Write-Ok 'Frontend ready'
}

# --------------------------------------------------------------- verify chain
Write-Step 'Verifying the signal chain'
Push-Location $backend
& $venvPython selftest.py
$selftestOk = ($LASTEXITCODE -eq 0)
Pop-Location
if (-not $selftestOk) {
    Write-Host "Self-test FAILED. The filter or detector is misbehaving; fix that before trusting any reading." -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------- launch
Write-Step 'Starting backend  (http://127.0.0.1:8000)'
$backendProc = Start-Process -FilePath $venvPython -ArgumentList 'run_server.py' `
    -WorkingDirectory $backend -PassThru -WindowStyle Minimized

# Wait for the API to actually answer before starting the UI, so the browser
# never opens onto a "backend not reachable" toast.
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        Invoke-WebRequest 'http://127.0.0.1:8000/api/health' -UseBasicParsing -TimeoutSec 2 | Out-Null
        $ready = $true
        break
    } catch { }
}
if (-not $ready) {
    Write-Host "Backend did not come up. Run it manually to see the error:" -ForegroundColor Red
    Write-Host "    cd backend; .\.venv\Scripts\python.exe run_server.py" -ForegroundColor Yellow
    exit 1
}
Write-Ok 'Backend responding'

if ($Prod) {
    Write-Step 'Building the frontend'
    Push-Location $frontend
    npm run build
    Write-Step 'Serving production build at http://localhost:3000'
    Write-Host "`n    Press Ctrl+C to stop.`n" -ForegroundColor DarkGray
    npm run preview
    Pop-Location
} else {
    Write-Step 'Starting frontend at http://localhost:3000'
    Write-Host "`n    Press Ctrl+C to stop.`n" -ForegroundColor DarkGray
    Push-Location $frontend
    npm run dev
    Pop-Location
}

# Ctrl+C on the frontend lands here; take the backend down with it rather than
# leaving an orphan holding port 8000.
Write-Step 'Shutting down backend'
if ($backendProc -and -not $backendProc.HasExited) {
    Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue
}
Write-Ok 'Stopped.'
