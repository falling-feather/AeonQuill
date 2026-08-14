param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId
)

$ErrorActionPreference = 'Stop'
$miaohuiProcesses = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$miaohuiIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$miaohuiIds.Add($RootProcessId)

do {
  $miaohuiAdded = $false
  foreach ($miaohuiProcess in $miaohuiProcesses) {
    if ($miaohuiIds.Contains([int]$miaohuiProcess.ParentProcessId) -and -not $miaohuiIds.Contains([int]$miaohuiProcess.ProcessId)) {
      [void]$miaohuiIds.Add([int]$miaohuiProcess.ProcessId)
      $miaohuiAdded = $true
    }
  }
} while ($miaohuiAdded)

$miaohuiMetrics = foreach ($miaohuiProcessId in $miaohuiIds) {
  $miaohuiProcess = Get-Process -Id $miaohuiProcessId -ErrorAction SilentlyContinue
  if ($null -ne $miaohuiProcess) {
    $miaohuiCpuSeconds = if ($null -eq $miaohuiProcess.CPU) { 0 } else { [double]$miaohuiProcess.CPU }
    [pscustomobject]@{
      pid = [int]$miaohuiProcess.Id
      name = [string]$miaohuiProcess.ProcessName
      workingSetBytes = [long]$miaohuiProcess.WorkingSet64
      privateBytes = [long]$miaohuiProcess.PrivateMemorySize64
      cpuSeconds = $miaohuiCpuSeconds
    }
  }
}

@($miaohuiMetrics) | ConvertTo-Json -Compress
