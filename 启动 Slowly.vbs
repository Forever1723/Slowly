' ============================================================
'  Slowly · 静默启动器
'  双击本文件即可：没有黑窗口，直接以独立应用窗口打开 Slowly
'  想让它开机自动运行，把本文件的快捷方式放进
'  「开始菜单 → 启动」或「shell:startup」文件夹即可
' ============================================================
Option Explicit

Dim fso, shell, here, target, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
target = here & "\启动 Slowly.cmd"

If Not fso.FileExists(target) Then
  MsgBox "没有找到「启动 Slowly.cmd」。" & vbCrLf & _
         "请确认本文件和它在同一个文件夹里。", 48, "Slowly"
  WScript.Quit 1
End If

' 0 = 隐藏窗口，False = 不等待（服务器在后台继续跑）
cmd = "cmd /c """ & target & """ --app"
shell.Run cmd, 0, False
