$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $excel.Workbooks.Open('c:\Users\johnd\Documents\coding\go-links-shortcuts\pics\Go links.xlsx')
$ws = $wb.Worksheets.Item(1)
$rows = $ws.UsedRange.Rows.Count
$cols = $ws.UsedRange.Columns.Count
Write-Host "Rows: $rows, Cols: $cols"
for ($r = 1; $r -le [Math]::Min($rows, 200); $r++) {
  $row = @()
  for ($c = 1; $c -le $cols; $c++) {
    $row += $ws.Cells($r, $c).Text
  }
  Write-Host ($row -join "`t")
}
$wb.Close($false)
$excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
