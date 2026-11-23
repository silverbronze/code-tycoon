# Code Tycoon installer for Windows. What it does and how to undo it: https://codetycoon.dev/setup.txt
#
#   $env:CT_SETUP_CODE='ABCD-EFGH'; irm https://codetycoon.dev/install.ps1 | iex
#
# 1. Uses your Node if it is 22.13 or newer. Otherwise downloads the official Node 22 LTS build from
#    nodejs.org, checks it against nodejs.org's SHASUMS256.txt, and unpacks it into ~\.codetycoon\node.
# 2. Installs the code-tycoon npm package into ~\.codetycoon\pkg\<version>.
# 3. Runs `code-tycoon setup`: Claude Code hooks, start at login, the server, and (with the setup
#    code) the connection to your account at app.codetycoon.dev.
# No admin rights, nothing on PATH, nothing outside ~\.codetycoon except the hooks in
# ~\.claude\settings.json (backed up first) and a launcher in your Startup folder.
# Run it again to update. Undo: ~\.codetycoon\bin\code-tycoon.cmd uninstall
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Fail($msg) { Write-Host "Code Tycoon setup failed: $msg"; throw "Code Tycoon setup failed: $msg" }

$ct = Join-Path $env:USERPROFILE '.codetycoon'
$nodeDir = Join-Path $ct 'node'
$pkg = if ($env:CT_PACKAGE) { $env:CT_PACKAGE } else { 'code-tycoon@latest' }
function Test-NodeOk($exe) {
  try {
    & $exe -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" *> $null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

$node = $null
$sys = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $env:CT_FORCE_NODE -and $sys -and (Test-NodeOk $sys.Source)) { $node = $sys.Source }
elseif ((Test-Path "$nodeDir\node.exe") -and (Test-NodeOk "$nodeDir\node.exe")) { $node = "$nodeDir\node.exe" }
else {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = 'https://nodejs.org/dist/latest-v22.x'
  Write-Host 'Downloading Node 22 LTS from nodejs.org...'
  try { $sums = [Text.Encoding]::UTF8.GetString((Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).RawContentStream.ToArray()) }
  catch { Fail 'Node download failed: no internet?' }
  $line = ($sums -split "`n") | Where-Object { $_ -match "\snode-v[\d.]+-win-$arch\.zip\s*$" } | Select-Object -First 1
  if (-not $line) { Fail "nodejs.org has no Node 22 build for win-$arch" }
  $want, $file = $line.Trim() -split '\s+'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('ct-node-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    try { Invoke-WebRequest "$base/$file" -OutFile "$tmp\$file" -UseBasicParsing } catch { Fail 'Node download failed: no internet?' }
    if ((Get-FileHash "$tmp\$file" -Algorithm SHA256).Hash.ToLower() -ne $want.ToLower()) { Fail "the Node download does not match nodejs.org's checksum" }
    $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tarExe) { & $tarExe -xf "$tmp\$file" -C $tmp; if ($LASTEXITCODE -ne 0) { Fail 'could not unpack Node' } }
    else { Expand-Archive "$tmp\$file" -DestinationPath $tmp -Force }
    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
    New-Item -ItemType Directory -Path $ct -Force | Out-Null
    Move-Item (Join-Path $tmp ($file -replace '\.zip$', '')) $nodeDir
  } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  $node = "$nodeDir\node.exe"
}
Write-Host "Node: $node ($(& $node --version))"

$npmCli = Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'
function Invoke-Npm { if (Test-Path $npmCli) { & $node $npmCli @args } else { & npm.cmd @args } }

Write-Host "Installing $pkg..."
$stage = Join-Path $ct 'pkg\.staging'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Invoke-Npm install $pkg --prefix $stage --omit=dev --no-audit --no-fund --loglevel=error | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'npm could not install code-tycoon: no internet?' }
$ver = (Get-Content "$stage\node_modules\code-tycoon\package.json" -Raw | ConvertFrom-Json).version
if (-not $ver) { Fail 'the package did not install completely' }
$dest = Join-Path $ct "pkg\$ver"
if (Test-Path "$dest\node_modules\code-tycoon\package.json") {
  # this version is already here (and may be running): keep it
  Remove-Item $stage -Recurse -Force
} else {
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Move-Item $stage $dest
}
Write-Host "Code Tycoon ${ver}: $dest"

$setupArgs = @('--no-warnings', "$dest\node_modules\code-tycoon\bin\code-tycoon.mjs", 'setup')
if ($env:CT_SETUP_CODE) { $setupArgs += @('--code', $env:CT_SETUP_CODE) }
if ($env:CT_RELAY) { $setupArgs += @('--relay', $env:CT_RELAY) }
& $node @setupArgs
if ($LASTEXITCODE -ne 0) { throw 'Code Tycoon setup failed (see the line above).' }
