# Assemble the Capacitor webDir from the game sources.
$root = $PSScriptRoot
$www = Join-Path $root "www"
if (Test-Path $www) { Remove-Item $www -Recurse -Force }
New-Item -ItemType Directory $www | Out-Null
Copy-Item (Join-Path $root "index.html") $www
Copy-Item (Join-Path $root "js") (Join-Path $www "js") -Recurse
Copy-Item (Join-Path $root "fonts") (Join-Path $www "fonts") -Recurse
Write-Output "www assembled: $((Get-ChildItem $www -Recurse -File | Measure-Object Length -Sum).Sum) bytes"
