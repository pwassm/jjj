<#
  restore-empty-dirs.ps1 - recreate directories recorded by purge-empty-dirs.ps1.
  The tree lives in the manifest CSV, so it costs nothing on disk until you want it back.

    .\restore-empty-dirs.ps1 -Manifest .\emptydirlogs\removed-EXECUTE-20260828-231500.csv
    .\restore-empty-dirs.ps1 -Manifest .\emptydirlogs\removed-EXECUTE-...csv -Execute
    .\restore-empty-dirs.ps1 -Manifest ... -Filter "G:\on_crucialb" -Execute
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Manifest,
    [string] $Filter,
    [switch] $Execute
)

$rows = Import-Csv $Manifest | Where-Object { $_.junkfiles -ne 'FAILED' }
if ($Filter) { $rows = $rows | Where-Object { $_.path -like "*$Filter*" } }

# shallowest first, so parents exist before their children
$rows = $rows | Sort-Object { [int]$_.depth }

$made = 0
foreach ($r in $rows) {
    if ([System.IO.Directory]::Exists($r.path)) { continue }
    if ($Execute) { [System.IO.Directory]::CreateDirectory($r.path) | Out-Null }
    else { Write-Host "would create: $($r.path)" }
    $made++
}

Write-Host ("`n{0}: {1} directories" -f $(if($Execute){"recreated"}else{"would recreate"}), $made)
if (-not $Execute) { Write-Host "PREVIEW - re-run with -Execute to actually create them." }
