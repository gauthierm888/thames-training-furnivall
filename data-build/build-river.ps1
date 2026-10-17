$ErrorActionPreference = 'Stop'
$main = Get-Content thames.json -Raw | ConvertFrom-Json
$extra = Get-Content extra.json -Raw | ConvertFrom-Json

$lat0 = 51.48841; $lon0 = -0.23020
$kx = 111320 * [Math]::Cos($lat0 * [Math]::PI / 180); $ky = 110574
function P($lat, $lon) { , @((($lon - $lon0) * $kx), (($lat - $lat0) * $ky)) }

# Centreline, ordered upstream (Putney side -> Kew side)
$a = ($main.elements | ? id -eq 860421850).geometry
$b = ($main.elements | ? id -eq 860421854).geometry
$down = @($a) + @($b | select -Skip 1)
[array]::Reverse($down)
$pts = @($down | % { P $_.lat $_.lon })

# Cumulative distance
$cum = New-Object double[] $pts.Count
for ($i = 1; $i -lt $pts.Count; $i++) {
  $dx = $pts[$i][0] - $pts[$i-1][0]; $dy = $pts[$i][1] - $pts[$i-1][1]
  $cum[$i] = $cum[$i-1] + [Math]::Sqrt($dx*$dx + $dy*$dy)
}
function At($s) {
  for ($i = 1; $i -lt $pts.Count; $i++) { if ($cum[$i] -ge $s) { break } }
  if ($i -ge $pts.Count) { $i = $pts.Count - 1 }
  $t = ($s - $cum[$i-1]) / [Math]::Max(1e-9, $cum[$i] - $cum[$i-1])
  , @(($pts[$i-1][0] + $t*($pts[$i][0]-$pts[$i-1][0])), ($pts[$i-1][1] + $t*($pts[$i][1]-$pts[$i-1][1])))
}
function Project($p) {
  $best = 1e18; $bs = 0
  for ($i = 1; $i -lt $pts.Count; $i++) {
    $ax=$pts[$i-1][0];$ay=$pts[$i-1][1];$dx=$pts[$i][0]-$ax;$dy=$pts[$i][1]-$ay
    $t=[Math]::Max(0,[Math]::Min(1,(($p[0]-$ax)*$dx+($p[1]-$ay)*$dy)/($dx*$dx+$dy*$dy)))
    $qx=$ax+$t*$dx-$p[0];$qy=$ay+$t*$dy-$p[1];$dd=$qx*$qx+$qy*$qy
    if($dd -lt $best){$best=$dd;$bs=$cum[$i-1]+$t*[Math]::Sqrt($dx*$dx+$dy*$dy)}
  }
  $bs
}

# Bridges
$bridges = foreach ($id in 576802756, 628685252, 576806141) {
  $e = $extra.elements | ? id -eq $id
  $p = P (($e.geometry.lat | measure -Average).Average) (($e.geometry.lon | measure -Average).Average)
  [pscustomobject]@{ name = $e.tags.name; s = (Project $p); poly = @($e.geometry | % { P $_.lat $_.lon }) }
}
$ulp = P 51.4817520 -0.2750003   # University of London Boat Club (OSM way 505403205)
$sStart = $bridges[0].s - 150; $sEnd = (Project $ulp) + 250

# Water polygon edges (riverbank ~ mean high water), incl. Chiswick Eyot
$segs = New-Object System.Collections.ArrayList; $outerSegs = New-Object System.Collections.ArrayList
$eyot = $null
foreach ($e in $extra.elements | ? { $_.type -eq 'way' -and $_.geometry -and -not $_.tags.bridge -and -not $_.tags.'man_made' }) {
  $g = @($e.geometry | % { P $_.lat $_.lon })
  if ($e.tags.name -eq 'Chiswick Eyot') { $eyot = $g }
  for ($i = 1; $i -lt $g.Count; $i++) { $sg = @($g[$i-1][0],$g[$i-1][1],$g[$i][0],$g[$i][1]); [void]$segs.Add($sg); if ($e.tags.name -ne 'Chiswick Eyot') { [void]$outerSegs.Add($sg) } }
}
function Ray($ox,$oy,$dx,$dy,$set) {
  $best = 400.0
  foreach ($sg in $set) {
    $ex=$sg[2]-$sg[0]; $ey=$sg[3]-$sg[1]
    $den = $dx*$ey - $dy*$ex
    if ([Math]::Abs($den) -lt 1e-12) { continue }
    $wx=$sg[0]-$ox; $wy=$sg[1]-$oy
    $t = ($wx*$ey - $wy*$ex)/$den; $u = ($wx*$dy - $wy*$dx)/$den
    if ($t -gt 0.5 -and $u -ge 0 -and $u -le 1 -and $t -lt $best) { $best = $t }
  }
  $best
}

$out = New-Object System.Collections.ArrayList
for ($s = $sStart; $s -le $sEnd; $s += 10) {
  $p = At $s; $p1 = At ($s - 15); $p2 = At ($s + 15)
  $tx = $p2[0]-$p1[0]; $ty = $p2[1]-$p1[1]; $n = [Math]::Sqrt($tx*$tx+$ty*$ty); $tx/=$n; $ty/=$n
  $lx = -$ty; $ly = $tx   # left normal (direction of travel = upstream)
  $wl = Ray $p[0] $p[1] $lx $ly $segs; $wr = Ray $p[0] $p[1] (-$lx) (-$ly) $segs; $ol = Ray $p[0] $p[1] $lx $ly $outerSegs; $or = Ray $p[0] $p[1] (-$lx) (-$ly) $outerSegs
  [void]$out.Add(('[{0:F1},{1:F1},{2:F1},{3:F1},{4:F1},{5:F1}]' -f $p[0],$p[1],$wl,$wr,$ol,$or))
}

$bj = ($bridges | % { '{{"name":"{0}","s":{1:F1},"poly":[{2}]}}' -f $_.name, ($_.s - $sStart), (($_.poly | % { '[{0:F1},{1:F1}]' -f $_[0],$_[1] }) -join ',') }) -join ','
$ej = ($eyot | % { '[{0:F1},{1:F1}]' -f $_[0],$_[1] }) -join ','

# PLA Fairway buoys (OSM seamark nodes; red = Surrey side, green = Middlesex side) and landmarks
$buoys = @(
  @('Dove Pier Buoy','green',51.48937,-0.23225), @('Black Lion Buoy','red',51.48777,-0.24310),
  @('Chiswick Steps Buoy','red',51.48164,-0.24989), @('LEP Buoy','green',51.47915,-0.25090),
  @("Duke's Meadow Buoy",'green',51.47566,-0.25171), @("Tradesmen's Buoy",'green',51.47178,-0.25630),
  @("Bull's Alley Buoy",'green',51.47130,-0.26344), @('Ship Inn Buoy','red',51.47161,-0.26720)
)
$bjs = ($buoys | % { $p = P $_[2] $_[3]; '{{"name":"{0}","colour":"{1}","x":{2:F1},"y":{3:F1} }}' -f $_[0],$_[1],$p[0],$p[1] }) -join ','
$lp = P 51.47189 -0.26908
$fp = P 51.4899455 -0.2316524   # Furnivall Sculling Club boathouse (OSM way 174088744)
$landmarks = ('{{"name":"University Stone (Boat Race finish)","x":{0:F1},"y":{1:F1} }}' -f $lp[0],$lp[1]) + ',' +
  ('{{"name":"Furnivall Sculling Club","x":{0:F1},"y":{1:F1} }}' -f $fp[0],$fp[1]) + ',' +
  ('{{"name":"UL Boat House","x":{0:F1},"y":{1:F1} }}' -f $ulp[0],$ulp[1])

# Floating piers / pontoons (OSM man_made=pier areas) - obstacles near the banks
$pj = Get-Content piers.json -Raw | ConvertFrom-Json
$pj2 = Get-Content piers2.json -Raw | ConvertFrom-Json
$pierEls = @($pj.elements) + @($pj2.elements | ? { $id = $_.id; -not ($pj.elements | ? { $_.id -eq $id }) })
$piers = foreach ($e in $pierEls | ? { $_.type -eq 'way' -and $_.geometry.Count -ge 4 -and $_.tags.'man_made' -eq 'pier' }) {
  $g = @($e.geometry | % { P $_.lat $_.lon })
  $cx = ($g | % { $_[0] } | measure -Average).Average; $cy = ($g | % { $_[1] } | measure -Average).Average
  if ((Project @($cx, $cy)) -lt $sStart -or (Project @($cx, $cy)) -gt $sEnd) { continue }
  '{{"name":"{0}","poly":[{1}]}}' -f ($e.tags.name -replace '"',''), (($g | % { '[{0:F1},{1:F1}]' -f $_[0],$_[1] }) -join ',')
}
$js = @"
// Generated by build-river.ps1 from OpenStreetMap data (c) OpenStreetMap contributors, ODbL.
// Centreline points every 10 m going UPSTREAM: [x(m east), y(m north), distToLeftBank, distToRightBank, outerLeftBank, outerRightBank] at ~mean high water.
// "outer" distances ignore Chiswick Eyot (used to draw the backwater behind the island).
window.RIVER = {
  step: 10,
  points: [$($out -join ',')],
  bridges: [$bj],
  eyot: [$ej],
  buoys: [$bjs],
  landmarks: [$landmarks],
  piers: [$($piers -join ',')]
};
"@
Set-Content -Path river-data.js -Value $js -Encoding UTF8
"points=$($out.Count) length=$([int]($sEnd-$sStart)) m"
$bridges | % { "{0} at {1:N0} m" -f $_.name, ($_.s - $sStart) }
