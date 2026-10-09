$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 18 or newer is required.' }
& $node.Source (Join-Path $PSScriptRoot 'install.js') @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
