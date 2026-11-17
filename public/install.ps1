# Installs the Berthy CLI on Windows. It downloads the release binary, checks it against the
# release's checksums.txt, saves it as berthy.exe and adds its folder to your user PATH.
#
#   irm https://berthy.pages.dev/install.ps1 | iex
#
# Settings are environment variables. Set them before the command:
#
#   $env:BERTHY_VERSION = 'v0.1.0'; irm https://berthy.pages.dev/install.ps1 | iex
#
#   BERTHY_VERSION         A release tag, for example v0.1.0. Default: the latest release.
#   BERTHY_INSTALL_DIR     Where berthy.exe goes. Default: %LOCALAPPDATA%\Programs\berthy.
#   BERTHY_NO_MODIFY_PATH  Set to 1 to leave your PATH alone.
#   BERTHY_RELEASE_URL     A mirror of the releases, laid out as <url>/<version>/<file>, the same
#                          variable `berthy setup` reads. Needs BERTHY_VERSION.
#
# On Linux and macOS: curl -fsSL https://berthy.pages.dev/install.sh | sh

# Everything runs in one block, so the preferences below end with it and a download that is cut
# short does nothing. Errors are thrown, not `exit`, which would close your terminal.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
    throw 'install.ps1 is for Windows. On Linux and macOS: curl -fsSL https://berthy.pages.dev/install.sh | sh'
  }
  if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'There is no Berthy build for 32-bit Windows.'
  }
  # Windows PowerShell 5.1 can default to TLS 1.0, which GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $releases = 'https://github.com/fredimachado/berthy/releases'
  # The amd64 build also runs on Windows on Arm, under emulation.
  $asset = 'berthy-windows-amd64.exe'

  $version = $env:BERTHY_VERSION
  if ($version -match '^\d') { $version = "v$version" }
  if ($env:BERTHY_RELEASE_URL) {
    if (-not $version) { throw 'BERTHY_RELEASE_URL needs BERTHY_VERSION.' }
    $base = $env:BERTHY_RELEASE_URL.TrimEnd('/') + "/$version"
  } elseif ($version) {
    $base = "$releases/download/$version"
  } else {
    $base = "$releases/latest/download"
  }

  $dir = $env:BERTHY_INSTALL_DIR
  if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'Programs\berthy' }
  $exe = Join-Path $dir 'berthy.exe'

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('berthy-install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $download = Join-Path $tmp $asset
    $sums = Join-Path $tmp 'checksums.txt'

    $label = if ($version) { $version } else { 'latest release' }
    Write-Host "Downloading $asset ($label)"
    foreach ($file in @{ $asset = $download; 'checksums.txt' = $sums }.GetEnumerator()) {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$($file.Key)" -OutFile $file.Value
      } catch {
        throw "Could not download $base/$($file.Key): $($_.Exception.Message)"
      }
    }

    $expected = $null
    foreach ($line in Get-Content $sums) {
      $fields = $line.Trim() -split '\s+'
      if ($fields.Count -ge 2 -and $fields[1].TrimStart('*') -eq $asset) {
        $expected = $fields[0]
        break
      }
    }
    if (-not $expected) { throw "checksums.txt has no line for $asset." }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $download).Hash
    if ($actual -ne $expected) {
      throw "The checksum of $asset does not match checksums.txt. Nothing was installed.`n  expected $expected`n  got      $($actual.ToLower())"
    }
    Write-Host 'Checksum matches checksums.txt'

    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Move-Item -Force -Path $download -Destination $exe
    Write-Host "Installed $exe"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  & $exe version

  if ($env:BERTHY_NO_MODIFY_PATH -ne '1') {
    $same = { param($entry) $entry.TrimEnd('\') -ieq $dir.TrimEnd('\') }
    # Read and write the registry value as it is stored, so entries such as %USERPROFILE%\bin
    # stay unexpanded. [Environment]::SetEnvironmentVariable would write them expanded.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $stored = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
      $entries = @($stored -split ';' | Where-Object { $_ })
      if (-not ($entries | Where-Object { & $same $_ })) {
        $kind = if ($stored) { $key.GetValueKind('Path') } else { 'ExpandString' }
        $key.SetValue('Path', (($entries + $dir) -join ';'), $kind)
        # Tell running programs the environment changed: removing a variable that does not
        # exist changes nothing and sends the Windows notification.
        [Environment]::SetEnvironmentVariable('BERTHY_INSTALL_NOTIFY', $null, 'User')
        Write-Host "Added $dir to your user PATH. New terminals will find berthy."
      }
    } finally {
      $key.Close()
    }
    # This terminal, too.
    if (-not ($env:Path -split ';' | Where-Object { $_ -and (& $same $_) })) {
      $env:Path = $env:Path.TrimEnd(';') + ";$dir"
    }
  }

  Write-Host 'Next: https://berthy.pages.dev/docs/prepare-a-server-and-set-it-up/'
}
