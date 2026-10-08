# Songloft chuanhuatong plugin builder (ASCII-only output)
# Output: dist/chuanhuatong.jsplugin.zip
#   entryHash = sha256(main.js)
#   zipHash   = sha256( sorted "<path>\n<sha256(content)>\n" concatenation )
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$buildDir = Join-Path $root "build"
$distDir = Join-Path $root "dist"
$mainSrc = Join-Path $root "src\main.js"
$staticSrc = Join-Path $root "static"
$manifestSrc = Join-Path $root "plugin.json"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-Sha256Hex {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha.ComputeHash($Bytes)
    } finally {
        $sha.Dispose()
    }
    return ([BitConverter]::ToString($hashBytes) -replace "-", "").ToLowerInvariant()
}

function Convert-ToForwardPath {
    param([string]$Path)
    return ($Path -replace '\\', '/')
}

# 1. Prepare build dir
if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }
New-Item -ItemType Directory -Path $buildDir | Out-Null
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

# 2. Entry main.js
$mainBytes = [System.IO.File]::ReadAllBytes($mainSrc)
[System.IO.File]::WriteAllBytes((Join-Path $buildDir "main.js"), $mainBytes)

# 3. Static assets
Copy-Item $staticSrc (Join-Path $buildDir "static") -Recurse

# 4. Collect entries (plugin.json excluded), sort by path
$entries = @()
Get-ChildItem -Path $buildDir -Recurse -File | ForEach-Object {
    $rel = Convert-ToForwardPath $_.FullName.Substring($buildDir.Length + 1)
    if ($rel -ne "plugin.json") {
        $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
        $entries += [pscustomobject]@{
            path = $rel
            hash = (Get-Sha256Hex -Bytes $bytes)
        }
    }
}
$entries = $entries | Sort-Object -Property path

$entryHash = Get-Sha256Hex -Bytes $mainBytes

# 5. Canonical zipHash
$nl = [string][char]10
$canonical = New-Object System.IO.MemoryStream
try {
    foreach ($e in $entries) {
        $line = $e.path + $nl + $e.hash + $nl
        $lineBytes = $utf8NoBom.GetBytes($line)
        $canonical.Write($lineBytes, 0, $lineBytes.Length)
    }
    $zipHash = Get-Sha256Hex -Bytes $canonical.ToArray()
} finally {
    $canonical.Dispose()
}

# 6. Update plugin.json (root + build copy)
$manifest = Get-Content $manifestSrc -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest.entryHash = $entryHash
$manifest.zipHash = $zipHash
$jsonOut = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($manifestSrc, $jsonOut, $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $buildDir "plugin.json"), $jsonOut, $utf8NoBom)

# 7. Create zip (root level, forward-slash entry names)
$zipPath = Join-Path $distDir "chuanhuatong.jsplugin.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$fileStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::CreateNew)
try {
    $zip = New-Object System.IO.Compression.ZipArchive(
        $fileStream, [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        $allFiles = Get-ChildItem -Path $buildDir -Recurse -File | Sort-Object FullName
        foreach ($f in $allFiles) {
            $rel = Convert-ToForwardPath $f.FullName.Substring($buildDir.Length + 1)
            $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try {
                $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
                $entryStream.Write($bytes, 0, $bytes.Length)
            } finally {
                $entryStream.Close()
            }
        }
    } finally {
        $zip.Dispose()
    }
} finally {
    $fileStream.Close()
}

Write-Host ""
Write-Host "BUILD OK : $zipPath"
Write-Host "entryHash = $entryHash"
Write-Host "zipHash   = $zipHash"
Write-Host ""
Write-Host "ZIP entries:"
Get-ChildItem -Path $buildDir -Recurse -File | Sort-Object FullName | ForEach-Object {
    $rel = Convert-ToForwardPath $_.FullName.Substring($buildDir.Length + 1)
    Write-Host ("  - " + $rel)
}
