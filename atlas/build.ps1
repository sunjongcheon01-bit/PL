# 결함 아틀라스 빌드: atlas_src.html 의 /*__DATA__*/ 자리에 atlas_data.json 을 넣어 ../defect_atlas.html 을 만듭니다.
#   실행: powershell -ExecutionPolicy Bypass -File atlas\build.ps1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$enc = New-Object Text.UTF8Encoding($false)
$src = [IO.File]::ReadAllText((Join-Path $here "atlas_src.html"))
$data = [IO.File]::ReadAllText((Join-Path $here "atlas_data.json"))
$head = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
[IO.File]::WriteAllText((Join-Path $here "..\defect_atlas.html"), $head + $src.Replace('/*__DATA__*/', $data), $enc)
Write-Output "defect_atlas.html 생성 완료"
