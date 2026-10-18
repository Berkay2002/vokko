# Samples for -Seconds: CPU % (of one core) of the process trees rooted at -Roots, and per GPU adapter (LUID) the average
# 3D and VideoEncode engine use from the Windows GPU counters (what Task Manager shows). Prints JSON.
param([int]$Seconds = 10, [string]$Roots = "")
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
function Tree($root) {
  $ids = @($root); $frontier = @($root)
  while ($frontier.Count) { $frontier = @($procs | Where-Object { $frontier -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId }); $ids += $frontier }
  $ids
}
$trees = @{}
foreach ($r in ($Roots -split "," | Where-Object { $_ })) { $trees[$r] = @(Tree ([int]$r)) }
function CpuOf($ids) { ($ids | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum }
$before = @{}; foreach ($k in $trees.Keys) { $before[$k] = CpuOf $trees[$k] }
$sw = [Diagnostics.Stopwatch]::StartNew()
$samples = Get-Counter -Counter '\GPU Engine(*engtype_3D)\Utilization Percentage', '\GPU Engine(*engtype_VideoEncode)\Utilization Percentage' -SampleInterval 1 -MaxSamples $Seconds -ErrorAction SilentlyContinue
$elapsed = $sw.Elapsed.TotalSeconds
$cpu = @{}; foreach ($k in $trees.Keys) { $cpu[$k] = [math]::Round(100 * ((CpuOf $trees[$k]) - $before[$k]) / $elapsed, 1) }
$gpu = @{}
foreach ($s in $samples) {
  foreach ($c in $s.CounterSamples) {
    if ($c.InstanceName -notmatch 'luid_(0x[0-9a-f]+_0x[0-9a-f]+).*engtype_(\w+)') { continue }
    $key = "$($Matches[1]) $($Matches[2])"
    $gpu[$key] = ($gpu[$key] ?? 0) + $c.CookedValue / $samples.Count
  }
}
$gpuOut = @{}; foreach ($k in $gpu.Keys) { $gpuOut[$k] = [math]::Round($gpu[$k], 1) }
$mem = @{}
foreach ($c in (Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage').CounterSamples) { if ($c.InstanceName -match 'luid_(0x[0-9a-f]+_0x[0-9a-f]+)') { $mem[$Matches[1]] = [math]::Round($c.CookedValue / 1MB) } }
@{ cpu = $cpu; gpu = $gpuOut; dedicatedMiB = $mem; totalCpu = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average, 0) } | ConvertTo-Json -Compress
