<#
  make-thumbs.ps1 — generate low-res gallery thumbnails for the trip PWA.

  The Photos tab used to decrypt every full-res (1600px, ~300 KB) image up front,
  which was slow and memory-hungry once the album grew past ~180 photos. This
  script produces a small companion JPEG for each photo so the grid can show a
  fast, light thumbnail; the full image is only decrypted when a photo is opened.

    build/photos/<id>.jpg  ->  build/photos/thumbs/<id>.jpg   (long edge THUMB_EDGE, quality THUMB_QUALITY)

  Incremental: a thumb is regenerated only when it is missing or older than its
  source. Uses System.Drawing (built into Windows / PowerShell 7) so it needs no
  npm install and no sharp. After running, encrypt with `node build/encrypt-photos.mjs`.

  Usage:
    pwsh build/make-thumbs.ps1              # incremental
    pwsh build/make-thumbs.ps1 -Force       # rebuild every thumb
    pwsh build/make-thumbs.ps1 -Edge 480 -Quality 62
#>
[CmdletBinding()]
param(
  [int]$Edge = 420,
  [int]$Quality = 60,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $scriptDir 'photos'
$outDir = Join-Path $srcDir 'thumbs'

if (-not (Test-Path $srcDir)) {
  Write-Output "ℹ️ No build/photos/ folder — nothing to thumbnail."
  exit 0
}
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$jpegEncoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)

$files = Get-ChildItem -Path $srcDir -File -Filter '*.jpg' | Where-Object { $_.Name -notlike '.*' }
$made = 0; $skipped = 0; $failed = 0

foreach ($f in $files) {
  $out = Join-Path $outDir $f.Name
  if (-not $Force -and (Test-Path $out) -and ((Get-Item $out).LastWriteTimeUtc -ge $f.LastWriteTimeUtc)) {
    $skipped++
    continue
  }
  try {
    $img = [System.Drawing.Image]::FromFile($f.FullName)
    try {
      $scale = [Math]::Min($Edge / $img.Width, $Edge / $img.Height)
      if ($scale -gt 1) { $scale = 1 }   # never upscale
      $w = [Math]::Max(1, [int][Math]::Round($img.Width * $scale))
      $h = [Math]::Max(1, [int][Math]::Round($img.Height * $scale))
      $bmp = New-Object System.Drawing.Bitmap($w, $h)
      try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
          $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
          $g.DrawImage($img, 0, 0, $w, $h)
        } finally { $g.Dispose() }
        $bmp.Save($out, $jpegEncoder, $encParams)
      } finally { $bmp.Dispose() }
    } finally { $img.Dispose() }
    $made++
  } catch {
    $failed++
    Write-Warning "Failed on $($f.Name): $($_.Exception.Message)"
  }
}

Write-Output ("Thumbs done — {0} generated, {1} up-to-date, {2} failed (edge={3}px q{4}) -> {5}" -f $made, $skipped, $failed, $Edge, $Quality, $outDir)
if ($failed -gt 0) { exit 1 }
