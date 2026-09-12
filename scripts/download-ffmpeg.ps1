# DirectorCam FFmpeg Download Script (mirror-aware)
param([string]$OutDir = "$PSScriptRoot\..\src-tauri")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Write-Host "=== DirectorCam FFmpeg Bundler ===" -ForegroundColor Cyan

$Zip = "$env:TEMP\ffmpeg_dc.zip"
$ExtractDir = "$env:TEMP\ffmpeg_dc_extract"
$Target = Join-Path $OutDir "ffmpeg.exe"

# Skip if already bundled
if (Test-Path $Target) {
    $size = [math]::Round((Get-Item $Target).Length / 1MB, 1)
    Write-Host "ffmpeg.exe already bundled ($size MB), skipping" -ForegroundColor Green
    exit 0
}

$Mirrors = @(
    "https://registry.npmmirror.com/-/binary/ffmpeg-static/ffmpeg-master-latest-win64-lgpl.zip",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip",
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
)

foreach ($url in $Mirrors) {
    Write-Host "Trying: $url" -ForegroundColor Yellow
    try {
        $client = New-Object System.Net.WebClient
        $client.Headers.Add("User-Agent", "DirectorCam/1.0")
        $client.DownloadFile($url, $Zip)
        if ((Get-Item $Zip).Length -gt 1000000) {
            Write-Host "Downloaded $([math]::Round((Get-Item $Zip).Length/1MB,1)) MB" -ForegroundColor Green
            break
        }
    } catch { Write-Host "Failed: $_" -ForegroundColor Red; continue }
}

if (-not (Test-Path $Zip) -or (Get-Item $Zip).Length -lt 1000000) {
    Write-Host "ERROR: Could not download FFmpeg. Please download manually:" -ForegroundColor Red
    Write-Host "  https://github.com/BtbN/FFmpeg-Builds/releases" -ForegroundColor Yellow
    Write-Host "  Extract ffmpeg.exe to: $Target" -ForegroundColor Yellow
    exit 1
}

if (Test-Path $ExtractDir) { Remove-Item $ExtractDir -Recurse -Force }
Expand-Archive $Zip -DestinationPath $ExtractDir -Force
$Exe = Get-ChildItem $ExtractDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $Exe) { Write-Host "ERROR: ffmpeg.exe not found in archive"; exit 1 }
Copy-Item $Exe.FullName $Target -Force
$Probe = Get-ChildItem $ExtractDir -Recurse -Filter "ffprobe.exe" | Select-Object -First 1
if ($Probe) { Copy-Item $Probe.FullName (Join-Path $OutDir "ffprobe.exe") -Force }
Remove-Item $Zip -Force -ErrorAction SilentlyContinue
Remove-Item $ExtractDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "=== Done! FFmpeg bundled ($([math]::Round((Get-Item $Target).Length/1MB,1)) MB) ===" -ForegroundColor Green