$WshShell = New-Object -ComObject WScript.Shell
$Desktop = [System.Environment]::GetFolderPath('Desktop')
$Shortcut = $WshShell.CreateShortcut("$Desktop\2027考研专业课双轨背诵手卷.lnk")
$Shortcut.TargetPath = "D:\AI_file\706_807专业课背诵手卷\index.html"
$Shortcut.WorkingDirectory = "D:\AI_file\706_807专业课背诵手卷"
$Shortcut.IconLocation = "D:\AI_file\706_807专业课背诵手卷\app.ico, 0"
$Shortcut.Description = "2027 考研专业课双轨随身背诵手卷 (706/807)"
$Shortcut.Save()
Write-Host "已在桌面成功创建快捷方式并绑定【方案 02：文心双轨 · 典雅线装】精美桌面图标！" -ForegroundColor Green
