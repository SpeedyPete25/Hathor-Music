param(
  [switch]$Remove,
  [string]$WorkspacePath
)

$ErrorActionPreference = "Stop"

$taskName = "Hathor-PM2-Resurrect"

function Resolve-WorkspaceRoot {
  if ($WorkspacePath) {
    return (Resolve-Path -Path $WorkspacePath).Path
  }

  if (-not $PSScriptRoot) {
    throw "Unable to resolve script root. Provide -WorkspacePath explicitly."
  }

  # Default layout: <repo>/scripts/setup-pm2-autostart.ps1
  return (Resolve-Path -Path (Join-Path $PSScriptRoot "..")).Path
}

$workspace = Resolve-WorkspaceRoot

function Ensure-Pm2Exists {
  $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
  if (-not $pm2) {
    throw "PM2 is not installed or not on PATH. Install it with: npm install -g pm2"
  }
}

function Remove-TaskIfExists {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'."
  } else {
    Write-Host "Scheduled task '$taskName' was not found."
  }
}

if ($Remove) {
  Remove-TaskIfExists
  exit 0
}

Ensure-Pm2Exists

if (-not (Test-Path (Join-Path $workspace "package.json"))) {
  throw "No package.json found in '$workspace'. Pass -WorkspacePath with your bot project root."
}

# Persist the current PM2 process list so resurrect has something to restore.
Push-Location $workspace
try {
  pm2 save | Out-Null
} finally {
  Pop-Location
}

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$powerShellPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$escapedWorkspace = $workspace.Replace("'", "''")
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"Set-Location '$escapedWorkspace'; pm2 resurrect`""

$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $workspace
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

Write-Host "Scheduled task '$taskName' created."
Write-Host "It will run 'pm2 resurrect' each time you log in."
Write-Host "Workspace: $workspace"
Write-Host ""
Write-Host "To remove it later, run:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/setup-pm2-autostart.ps1 -Remove"
