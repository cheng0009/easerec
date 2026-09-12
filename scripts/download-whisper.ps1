# DirectorCam whisper.cpp provisioner (mirror-aware)
# Downloads whisper-cli.exe (Windows x64) + a ggml model into src-tauri/whisper/
# Usage: powershell -File scripts/download-whisper.ps1 [-Model base]
param(
    [string]$OutDir = "$PSScriptRoot\..\src-tauri\whisper",
    [ValidateSet("tiny", "base", "small", "medium")]
    [string]$Model = "base",
    [string]$Tag = "b4938"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Write-Host "=== DirectorCam Whisper Provisioner ===" -ForegroundColor Cyan

$BinTarget = Join-Path $OutDir "whisper-cli.exe"
$ModelsDir = Join-Path $OutDir "models"
$ModelTarget = Join-Path $ModelsDir "ggml-$Model.bin"

function Get-File([string]$Url, [string]$Dest) {
    $tmp = "$env:TEMP\dc_dl_$(Get-Random)"
    $mirrors = @(
        "https://ghproxy.net/$Url",
        "https://gh-proxy.com/$Url",
        $Url
    )
    foreach ($u in $mirrors) {
        try {
            Write-Host "  trying: $u" -ForegroundColor Yellow
            $client = New-Object System.Net.WebClient
            $client.Headers.Add("User-Agent", "DirectorCam/1.0")
            $client.DownloadFile($u, $tmp)
            if ((Get-Item $tmp).Length -gt 100000) { Move-Item $tmp $Dest -Force; return $true }
        } catch { Write-Host "  failed: $_" -ForegroundColor Red }
        finally { if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue } }
    }
    return $false
}

if (-not (Test-Path $BinTarget) -or (Get-Item $BinTarget).Length -lt 100KB) {
    if (Test-Path $BinTarget) { Remove-Item $BinTarget -Force }
    Write-Host "[1/2] Downloading whisper.cpp (win x64)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $zip = "$env:TEMP\dc_whisper.zip"
    $ok = Get-File "https://github.com/ggml-org/whisper.cpp/releases/download/$Tag/whisper-bin-x64.zip" $zip
    if (-not $ok) {
        Write-Error "Could not download whisper.cpp. Manual: https://github.com/ggml-org/whisper.cpp/releases (extract whisper-cli.exe to $BinTarget)"
        exit 1
    }
    if (Test-Path "$env:TEMP\dc_whisper_x") { Remove-Item "$env:TEMP\dc_whisper_x" -Recurse -Force }
    Expand-Archive $zip -DestinationPath "$env:TEMP\dc_whisper_x" -Force
    # Recent whisper.cpp releases ship a TINY (~27KB) deprecation-stub named
    # whisper-cli.exe / main.exe / stream.exe that only prints a warning and
    # exits 1; the real whisper-cli.exe is a few hundred KB. Rule: pick the
    # largest whisper-cli.exe, ignoring any binary under 100KB.
    $exe = Get-ChildItem "$env:TEMP\dc_whisper_x" -Recurse -File |
        Where-Object { $_.Name -match "^whisper-cli\.exe$" -and $_.Length -gt 100000 } |
        Sort-Object Length -Descending | Select-Object -First 1
    if (-not $exe) {
        $exe = Get-ChildItem "$env:TEMP\dc_whisper_x" -Recurse -File |
            Where-Object { $_.Name -in @("main.exe", "whisper.exe") -and $_.Length -gt 100000 } |
            Sort-Object Length -Descending | Select-Object -First 1
    }
    if ($exe) { Copy-Item $exe.FullName $BinTarget -Force }
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\dc_whisper_x" -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $BinTarget) -or (Get-Item $BinTarget).Length -lt 100KB) {
        Write-Error "Extracted binary missing or too small (>100KB expected). Manual: https://github.com/ggml-org/whisper.cpp/releases"
        exit 1
    }
    Write-Host "  whisper-cli ready: $BinTarget" -ForegroundColor Green
} else {
    Write-Host "[1/2] whisper-cli.exe already present, skipping" -ForegroundColor Green
}

if (-not (Test-Path $ModelTarget)) {
    Write-Host "[2/2] Downloading ggml-$Model model (hf-mirror)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
    $ok = Get-File "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin" $ModelTarget
    if (-not $ok) {
        $ok = Get-File "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin" $ModelTarget
    }
    if (-not $ok) {
        Write-Error "Could not download model. Manual: https://hf-mirror.com/ggerganov/whisper.cpp/tree/main -> ggml-$Model.bin -> $ModelTarget"
        exit 1
    }
    Write-Host "  model ready: $ModelTarget" -ForegroundColor Green
} else {
    Write-Host "[2/2] ggml-$Model already present, skipping" -ForegroundColor Green
}

Write-Host "=== Done ===" -ForegroundColor Cyan
