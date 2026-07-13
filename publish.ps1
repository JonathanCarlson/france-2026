<#
.SYNOPSIS
  Re-encrypt the trip data + tickets with the family passphrase and publish to GitHub Pages.

.DESCRIPTION
  One-command publish for the France & Italy 2026 trip site. It:
    1. Prompts for the family passphrase (never written to disk; held in-process only).
    2. Runs build/encrypt.mjs        -> data/itinerary.enc.json  (from build/itinerary.json)
    3. Runs build/encrypt-assets.mjs -> data/tickets/*.enc       (from build/tickets/*)
    4. Commits ONLY the encrypted blobs (+ any staged app-code changes you pass -IncludeCode).
    5. Pushes to the personal GitHub account (JonathanCarlson) using a credential override,
       because Git Credential Manager on this box is pinned to the work EMU account.

  Live site: https://jonathancarlson.github.io/france-2026/

.PARAMETER Message
  Commit message. Defaults to a timestamped "publish trip data" message.

.PARAMETER IncludeCode
  Also commit modified app code (app.js, styles.css, sw.js, index.html, manifest.webmanifest).
  By default only data/ is committed so a data refresh never accidentally ships half-done code.

.PARAMETER SkipEncrypt
  Skip the encrypt step and just commit/push whatever is already in data/ (rare).

.EXAMPLE
  .\publish.ps1
  Re-encrypt data + tickets and push.

.EXAMPLE
  .\publish.ps1 -IncludeCode -Message "publish: enriched day details + tickets"
  Re-encrypt data AND ship pending app-code changes.
#>
[CmdletBinding()]
param(
  [string]$Message = "publish: refresh trip data ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))",
  [switch]$IncludeCode,
  [switch]$SkipEncrypt
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# --- Ensure node is on PATH (this box does not have it by default) ---
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  if (Test-Path 'C:\Program Files\nodejs\node.exe') { $env:Path += ';C:\Program Files\nodejs' }
  else { throw 'node not found on PATH. Install Node 20+ or add it to PATH.' }
}

if (-not $SkipEncrypt) {
  # --- Prompt for passphrase (in-memory only; never persisted) ---
  $secure = Read-Host -AsSecureString 'Family passphrase'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ($plain.Length -lt 6) { throw 'Passphrase must be at least 6 characters.' }
    $env:TRIP_PASSPHRASE = $plain
    Write-Host '-> Encrypting itinerary...' -ForegroundColor Cyan
    node build/encrypt.mjs
    if ($LASTEXITCODE -ne 0) { throw 'encrypt.mjs failed.' }
    Write-Host '-> Encrypting ticket assets...' -ForegroundColor Cyan
    node build/encrypt-assets.mjs
    if ($LASTEXITCODE -ne 0) { throw 'encrypt-assets.mjs failed.' }
  }
  finally {
    # Scrub the passphrase from memory/env as soon as encryption is done.
    Remove-Item Env:TRIP_PASSPHRASE -ErrorAction SilentlyContinue
    if ($bstr) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $plain = $null
  }
}

# --- Stage ---
git add data/itinerary.enc.json data/tickets/*.enc
if ($IncludeCode) {
  git add app.js styles.css sw.js index.html manifest.webmanifest 2>$null
}

# Nothing to do?
$staged = git diff --cached --name-only
if (-not $staged) {
  Write-Host 'Nothing changed - working tree clean. Done.' -ForegroundColor Yellow
  exit 0
}
Write-Host "Staged:`n$staged" -ForegroundColor DarkGray

# --- Commit (use -F to avoid PowerShell mangling the message) ---
$msgFile = New-TemporaryFile
Set-Content -Path $msgFile -Value $Message -Encoding UTF8
try { git commit -F $msgFile } finally { Remove-Item $msgFile -ErrorAction SilentlyContinue }

# --- Push to the personal account (credential override; GCM is pinned to work EMU) ---
Write-Host '-> Pushing to origin (JonathanCarlson)...' -ForegroundColor Cyan
$env:GIT_TERMINAL_PROMPT = '0'
git -c credential.helper= -c credential.helper="!gh auth git-credential" -c credential.username=JonathanCarlson push origin main
if ($LASTEXITCODE -ne 0) { throw 'git push failed. Check: gh auth status (JonathanCarlson) and that origin is the france-2026 repo.' }

Write-Host "`nPublished. Live in ~1 min: https://jonathancarlson.github.io/france-2026/" -ForegroundColor Green
