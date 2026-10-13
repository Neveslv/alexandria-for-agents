$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 24 or newer is required.' }
& $node.Source (Join-Path $PSScriptRoot 'install.js') @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
