param(
  [string]$Branch = "main",
  [string]$Message = "Update bot source",
  [string]$SecondRemote = "sc1forcrgh",
  [string]$SecondRemoteUrl = "https://github.com/harismy/sc1forcrgh.git",
  [switch]$Commit,
  [switch]$ForceSecondRemote
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [Parameter(Mandatory = $true)][string[]]$Args
  )
  & git -C $WorkDir @Args
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Args -join ' ') failed in $WorkDir"
  }
}

function Get-GitOutput {
  param(
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [Parameter(Mandatory = $true)][string[]]$Args
  )
  $out = & git -C $WorkDir @Args
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Args -join ' ') failed in $WorkDir"
  }
  return $out
}

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Invoke-Git -WorkDir $Repo -Args @("rev-parse", "--is-inside-work-tree") | Out-Null

$RemoteNames = @(Get-GitOutput -WorkDir $Repo -Args @("remote"))
if ($RemoteNames -notcontains $SecondRemote) {
  Invoke-Git -WorkDir $Repo -Args @("remote", "add", $SecondRemote, $SecondRemoteUrl)
} else {
  Invoke-Git -WorkDir $Repo -Args @("remote", "set-url", $SecondRemote, $SecondRemoteUrl)
}

$Status = @(Get-GitOutput -WorkDir $Repo -Args @("status", "--porcelain"))
if ($Status.Count -gt 0) {
  if (-not $Commit) {
    throw "Repo has uncommitted changes. Commit/stash them first, or rerun with -Commit."
  }
  Invoke-Git -WorkDir $Repo -Args @("add", "-A")
  Invoke-Git -WorkDir $Repo -Args @("commit", "-m", $Message)
}

Write-Host "Updating origin..."
Invoke-Git -WorkDir $Repo -Args @("pull", "--rebase", "origin", $Branch)
Invoke-Git -WorkDir $Repo -Args @("push", "origin", $Branch)

Write-Host "Updating $SecondRemote..."
Invoke-Git -WorkDir $Repo -Args @("fetch", $SecondRemote, $Branch)
if ($ForceSecondRemote) {
  Invoke-Git -WorkDir $Repo -Args @("push", "--force-with-lease", $SecondRemote, "${Branch}:${Branch}")
} else {
  Invoke-Git -WorkDir $Repo -Args @("push", $SecondRemote, "${Branch}:${Branch}")
}

Write-Host "Done."
