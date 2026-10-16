param(
  [string] $TargetDir = ""
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 downloads many times slower while it draws the progress bar.
$ProgressPreference = 'SilentlyContinue'

# Pinned tools: a new upstream release changes nothing until the version and SHA-256 here are updated.
# fb2cng: same version as FB2CNG_VERSION in the Dockerfile and fbc_sha256 of Windows in .github/workflows/release.yml.
$tools = @(
  @{
    Url = 'https://github.com/libjxl/libjxl/releases/download/v0.12.0/jxl-x64-windows-static.zip'
    Sha256 = '3025d7e308390796d20492322e606bc92decaee7b6bc99d3f7547870ae5db7de'
    File = 'djxl.exe'
  },
  @{
    Url = 'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-windows-x64.zip'
    Sha256 = '48886f506b21f62e4661f0f4cbfca19800897c385128e8902542d29a950c93f1'
    File = 'dwebp.exe'
  },
  @{
    Url = 'https://github.com/rupor-github/fb2cng/releases/download/v1.9.1/fbc-windows-amd64.zip'
    Sha256 = 'e688a0a4f38a57476ca213ccb7c16c0140c74f28eb8733ea42ce5ccbd3ce596a'
    File = 'fbc.exe'
  }
)

function Get-Sha256 {
  param([string] $Path)

  return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Archives are kept in the cache directory (CI restores it with actions/cache): a cached file is used
# only while its SHA-256 matches, otherwise it is downloaded again.
function Get-ToolArchive {
  param(
    [hashtable] $Tool,
    [string] $CacheDir
  )

  $archive = Join-Path $CacheDir ([IO.Path]::GetFileName(([Uri] $Tool.Url).AbsolutePath))
  if ((Test-Path $archive) -and (Get-Sha256 $archive) -eq $Tool.Sha256) {
    Write-Host "Using cached $archive"
    return $archive
  }

  Invoke-WebRequest -Uri $Tool.Url -OutFile $archive
  $hash = Get-Sha256 $archive
  if ($hash -ne $Tool.Sha256) {
    Remove-Item $archive -Force
    throw "SHA-256 mismatch for $($Tool.Url): $hash"
  }
  return $archive
}

# Expand-Archive cannot read Deflate64 (used by the libjxl 0.12 zip): extract with the bundled 7-Zip WebAssembly build.
# Only the program the app runs is copied; it needs no DLLs beyond Windows system ones.
function Extract-ZipFile {
  param(
    [string] $Archive,
    [string] $FileName,
    [string] $OutDir
  )

  & node (Join-Path $repoRoot 'build/extract-zip-file.js') $Archive $FileName $OutDir
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to extract $FileName from $Archive"
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($TargetDir)) {
  $TargetDir = Join-Path $repoRoot 'dist/win'
}

$targetDir = (Resolve-Path $TargetDir).Path
$binDir = Join-Path $targetDir 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$cacheDir = Join-Path $repoRoot 'dist/tools-cache'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

Write-Host "Bundling Windows tools into $binDir"

foreach ($tool in $tools) {
  Extract-ZipFile (Get-ToolArchive $tool $cacheDir) $tool.File $binDir
}

Write-Host 'Windows tool bundle complete.'
