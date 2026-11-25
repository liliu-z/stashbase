$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$executable = Join-Path $root 'release.nosync/win-unpacked/StashBase.exe'
$info = (Get-Item $executable).VersionInfo
$payloadVersion = '{0}.{1}.{2}' -f $info.ProductMajorPart, $info.ProductMinorPart, $info.ProductBuildPart
if ($payloadVersion -ne $version) {
  throw 'The Windows payload version does not match package.json. Build the current release first.'
}
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" |
  Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
if (-not $makeappx) { throw 'MakeAppx.exe is missing. Install the Windows SDK.' }
$staging = & node (Join-Path $PSScriptRoot 'packaging/windows-store.mjs')
if ($LASTEXITCODE -ne 0) { throw 'MSIX staging failed.' }
$output = Join-Path $root "release.nosync/StashBase-$version-store-x64.msix"
try {
  # Keep MakeAppx schema and semantic validation enabled. Store signs this
  # unsigned submission artifact; a separate signed copy is needed to sideload.
  & $makeappx.FullName pack /d $staging /p $output /o
  if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed with exit code $LASTEXITCODE" }
  if ((Get-Item $output).Length -eq 0) { throw 'MakeAppx produced an empty package.' }
  $hash = (Get-FileHash $output -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -Path "$output.sha256" -Value "$hash  $(Split-Path $output -Leaf)" -Encoding utf8
  Write-Host "Store package: $output"
  Write-Host "SHA256: $hash"
} finally {
  Remove-Item $staging -Recurse -Force
}
