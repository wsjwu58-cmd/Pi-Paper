param(
  [string]$MakensisPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$fixturePath = Join-Path $PSScriptRoot 'nsis-uninstall-cleanup-fixture.nsi'

if (-not $MakensisPath) {
  $nsisCacheRoot = Join-Path $env:LOCALAPPDATA 'electron-builder/Cache/nsis-3.0.4.1'
  $compiler = Get-ChildItem -LiteralPath $nsisCacheRoot -Filter 'makensis.exe' -File -Recurse -ErrorAction Stop |
    Where-Object { $_.FullName -match '[\\/]Bin[\\/]makensis\.exe$' } |
    Select-Object -First 1
  if (-not $compiler) {
    throw "Could not find bundled makensis.exe under $nsisCacheRoot. Pass -MakensisPath explicitly."
  }
  $MakensisPath = $compiler.FullName
}

$MakensisPath = (Resolve-Path -LiteralPath $MakensisPath).Path
$testToken = [Guid]::NewGuid().ToString('N')
$relativeTestRoot = "Software\VibePaperAcceptance\$testToken"
$registryWritePrefix = "$relativeTestRoot\"
$expectedInstallPath = Join-Path (Join-Path $env:TEMP "VibePaper Uninstall Cleanup Fixture\$testToken") 'Pi-Paper'
$otherInstallPath = Join-Path (Join-Path $env:TEMP "VibePaper Uninstall Cleanup Fixture\$testToken") 'Other-Pi-Paper'
$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempDirectory = [IO.Path]::GetFullPath((Join-Path $tempParent "VibePaper-NSIS-Cleanup-$testToken"))
$resolvedTempPrefix = $tempParent.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if (-not $relativeTestRoot.StartsWith("Software\VibePaperAcceptance\$testToken", [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The generated registry path is outside the fixture-owned test namespace.'
}
if (-not $tempDirectory.StartsWith($resolvedTempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The generated fixture build directory is outside the system temp directory.'
}

$registryBase = $null
$fixtureExe = Join-Path $tempDirectory 'VibePaper-NSIS-cleanup-fixture.exe'
$deniedRegistryPath = $null
$originalDeniedAcl = $null
$deleteDenyRule = $null
$installKey = "$relativeTestRoot\Install"
$uninstallKey = "$relativeTestRoot\Uninstall"

function Set-TestRegistryValue([string]$KeyPath, [string]$Name, [string]$Value) {
  if (-not $KeyPath.StartsWith($registryWritePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to write outside the fixture-owned registry root: $KeyPath"
  }
  $key = $registryBase.CreateSubKey($KeyPath)
  try {
    $key.SetValue($Name, $Value, [Microsoft.Win32.RegistryValueKind]::String)
  }
  finally {
    $key.Dispose()
  }
}

function Remove-TestRegistryRoot {
  $rootKey = $registryBase.OpenSubKey('Software\VibePaperAcceptance', $true)
  if ($rootKey) {
    try {
      $rootKey.DeleteSubKeyTree($testToken, $false)
    }
    finally {
      $rootKey.Dispose()
    }
  }
}

function Test-TestRegistryKey([string]$KeyPath) {
  if (-not $KeyPath.StartsWith($registryWritePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to inspect outside the fixture-owned registry root: $KeyPath"
  }
  $key = $registryBase.OpenSubKey($KeyPath, $false)
  if ($key) {
    $key.Dispose()
    return $true
  }
  return $false
}

function Reset-TestScenario {
  Remove-TestRegistryRoot
}

function Set-OwnedInstallRecord([string]$Location) {
  Set-TestRegistryValue $installKey 'InstallLocation' $Location
}

function Set-OwnedUninstallRecord([string]$Location, [string]$Scope, [switch]$IncludeInstallLocation) {
  $quote = [char]34
  $uninstallString = "$quote$Location\Uninstall Pi-Paper.exe$quote /$Scope"
  Set-TestRegistryValue $uninstallKey 'UninstallString' $uninstallString
  Set-TestRegistryValue $uninstallKey 'DisplayIcon' "$Location\Pi-Paper.exe,0"
  if ($IncludeInstallLocation) {
    Set-TestRegistryValue $uninstallKey 'InstallLocation' $Location
  }
}

function Invoke-Fixture([string]$Mode, [int]$ExpectedExitCode = 0) {
  $process = Start-Process -FilePath $fixtureExe -ArgumentList @("/mode=$Mode") -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne $ExpectedExitCode) {
    throw "Fixture mode '$Mode' returned exit code $($process.ExitCode); expected $ExpectedExitCode."
  }
}

try {
  $null = New-Item -ItemType Directory -Path $tempDirectory -Force
  $registryBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::CurrentUser,
    [Microsoft.Win32.RegistryView]::Registry64
  )

  Push-Location $tempDirectory
  try {
    $compileOutput = & $MakensisPath '/V2' "/DVPUC_TEST_TOKEN=$testToken" "/DVPUC_TEST_OUTFILE=$fixtureExe" $fixturePath 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      throw ("makensis failed with exit code $LASTEXITCODE." + [Environment]::NewLine + $compileOutput)
    }
  }
  finally {
    Pop-Location
  }

  # Exact ownership match: both stock keys are removed, including a trailing
  # separator in InstallLocation.
  Set-OwnedInstallRecord "$expectedInstallPath\"
  Set-OwnedUninstallRecord $expectedInstallPath 'currentuser'
  Invoke-Fixture 'CurrentUser'
  if ((Test-TestRegistryKey $installKey) -or (Test-TestRegistryKey $uninstallKey)) {
    $state = Get-Content -LiteralPath (Join-Path $tempDirectory 'fixture-state.txt') -Raw
    $state = $state.Replace($env:TEMP, '[fixture-temp]')
    throw "An exactly owned registration key remained after cleanup. $state"
  }

  # Different install path: neither registration is deleted by basename/prefix.
  Set-OwnedInstallRecord $otherInstallPath
  Set-OwnedUninstallRecord $otherInstallPath 'currentuser'
  Invoke-Fixture 'CurrentUser'
  if (-not (Test-TestRegistryKey $installKey) -or -not (Test-TestRegistryKey $uninstallKey)) {
    throw 'A registration for another directory was not preserved.'
  }
  Reset-TestScenario

  # A relative location cannot prove ownership of this absolute installation.
  Set-OwnedInstallRecord 'Pi-Paper'
  Invoke-Fixture 'CurrentUser'
  if (-not (Test-TestRegistryKey $installKey)) {
    throw 'A relative install location was not preserved.'
  }
  Reset-TestScenario

  # Both command scope and icon must match, independently.
  Set-OwnedUninstallRecord $expectedInstallPath 'allusers'
  Invoke-Fixture 'CurrentUser'
  if (-not (Test-TestRegistryKey $uninstallKey)) {
    throw 'An uninstall command for another scope was not preserved.'
  }
  Reset-TestScenario
  Set-OwnedUninstallRecord $expectedInstallPath 'currentuser'
  Set-TestRegistryValue $uninstallKey 'DisplayIcon' "$otherInstallPath\Pi-Paper.exe,0"
  Invoke-Fixture 'CurrentUser'
  if (-not (Test-TestRegistryKey $uninstallKey)) {
    throw 'A mismatched icon path was not preserved.'
  }
  Reset-TestScenario

  # Missing sibling key is normal; an owned install key is still removed.
  Set-OwnedInstallRecord $expectedInstallPath
  Invoke-Fixture 'CurrentUser'
  if (Test-TestRegistryKey $installKey) {
    throw 'The owned install key was not removed when its uninstall sibling was missing.'
  }

  # The stock uninstall key normally lacks InstallLocation; exact command and
  # icon ownership are sufficient. A present, mismatched InstallLocation blocks it.
  Set-OwnedUninstallRecord $expectedInstallPath 'currentuser'
  Invoke-Fixture 'CurrentUser'
  if (Test-TestRegistryKey $uninstallKey) {
    throw 'The owned uninstall key was not removed when InstallLocation was absent.'
  }
  Set-OwnedUninstallRecord $expectedInstallPath 'currentuser' -IncludeInstallLocation
  Set-TestRegistryValue $uninstallKey 'InstallLocation' $otherInstallPath
  Invoke-Fixture 'CurrentUser'
  if (-not (Test-TestRegistryKey $uninstallKey)) {
    throw 'A key with a mismatched InstallLocation was not preserved.'
  }
  Reset-TestScenario

  # "all" must target HKLM; a matching HKCU fixture remains untouched.
  Set-OwnedInstallRecord $expectedInstallPath
  Set-OwnedUninstallRecord $expectedInstallPath 'allusers'
  Invoke-Fixture 'all'
  if (-not (Test-TestRegistryKey $installKey) -or -not (Test-TestRegistryKey $uninstallKey)) {
    throw 'The all-users mode touched HKCU fixture registrations.'
  }
  Reset-TestScenario

  # Unknown context fails closed without deleting the HKCU fixture.
  Set-OwnedInstallRecord $expectedInstallPath
  Set-OwnedUninstallRecord $expectedInstallPath 'currentuser'
  Invoke-Fixture 'unknown' 2
  if (-not (Test-TestRegistryKey $installKey) -or -not (Test-TestRegistryKey $uninstallKey)) {
    throw 'An unknown install mode changed fixture registrations.'
  }
  Reset-TestScenario

  # Deny DELETE on one owned fixture key. Cleanup must report a non-zero result.
  # Incoming NSIS errors and working registers must survive successful cleanup.
  Invoke-Fixture 'CurrentUser-errorflag'

  # These inert .exe-named sentinels are never executed. Verify the production
  # postcondition guard without launching any real uninstaller or deleting apps.
  Invoke-Fixture 'verify-files'
  $null = New-Item -ItemType Directory -Path $expectedInstallPath -Force
  $mainSentinel = Join-Path $expectedInstallPath 'Pi-Paper.exe'
  $uninstallSentinel = Join-Path $expectedInstallPath 'Uninstall Pi-Paper.exe'
  Set-Content -LiteralPath $mainSentinel -Value 'fixture-only sentinel'
  Invoke-Fixture 'verify-files' 2
  Remove-Item -LiteralPath $mainSentinel -Force
  Set-Content -LiteralPath $uninstallSentinel -Value 'fixture-only sentinel'
  Invoke-Fixture 'verify-files' 2
  Invoke-Fixture 'verify-update'
  Set-Content -LiteralPath $mainSentinel -Value 'fixture-only sentinel'
  Invoke-Fixture 'verify-update'
  Remove-Item -LiteralPath $mainSentinel -Force
  Remove-Item -LiteralPath $uninstallSentinel -Force

  Set-OwnedInstallRecord $expectedInstallPath
  Set-OwnedUninstallRecord $expectedInstallPath 'currentuser'
  $deniedRegistryPath = "Registry::HKEY_CURRENT_USER\$installKey"
  $originalDeniedAcl = Get-Acl -LiteralPath $deniedRegistryPath
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $deleteDenyRule = [System.Security.AccessControl.RegistryAccessRule]::new(
    $currentSid,
    [System.Security.AccessControl.RegistryRights]::Delete,
    [System.Security.AccessControl.InheritanceFlags]::None,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Deny
  )
  $denyAcl = Get-Acl -LiteralPath $deniedRegistryPath
  $denyAcl.AddAccessRule($deleteDenyRule) | Out-Null
  Set-Acl -LiteralPath $deniedRegistryPath -AclObject $denyAcl
  Invoke-Fixture 'CurrentUser' 2
  if (-not (Test-TestRegistryKey $installKey)) {
    throw 'The cleanup failure fixture did not preserve its access-denied key.'
  }

  Write-Output "PASS: NSIS cleanup macro fixture completed under HKCU\$relativeTestRoot."
  Write-Output 'PASS: 17 cases covering ownership, missing paths, command/icon mismatch, hive isolation, state preservation, denied deletion, residual program files, and updater exceptions.'
}
finally {
  if ($deniedRegistryPath -and $originalDeniedAcl) {
    try {
      # Persist a modified descriptor. Reapplying an unmodified Get-Acl result
      # can leave the test's DELETE deny rule in place on Windows.
      $restoredAcl = Get-Acl -LiteralPath $deniedRegistryPath
      $restoredAcl.RemoveAccessRuleSpecific($deleteDenyRule)
      Set-Acl -LiteralPath $deniedRegistryPath -AclObject $restoredAcl
    }
    catch {
      Write-Warning "Could not restore the ACL for the fixture-owned key before cleanup: $_"
    }
  }
  if ($registryBase) {
    try {
      Remove-TestRegistryRoot
    }
    finally {
      $registryBase.Dispose()
    }
  }
  $resolvedTempDirectory = [IO.Path]::GetFullPath($tempDirectory)
  if ($resolvedTempDirectory.StartsWith($resolvedTempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $resolvedTempDirectory) -eq "VibePaper-NSIS-Cleanup-$testToken") {
    Remove-Item -LiteralPath $resolvedTempDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
  $fixtureInstallParent = [IO.Path]::GetFullPath((Split-Path -Parent $expectedInstallPath))
  if ($fixtureInstallParent.StartsWith($resolvedTempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $fixtureInstallParent) -eq $testToken) {
    Remove-Item -LiteralPath $fixtureInstallParent -Recurse -Force -ErrorAction SilentlyContinue
  }
}
