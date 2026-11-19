; electron-builder 的 NSIS 安装程序的两处改动，见 package-win.mjs。

; oneClick 为 false 时，安装程序先问“为哪位用户安装”；选“所有用户”要管理员权限，并改装到 Program Files。
; Repa 只按当前用户安装，这里跳过那一页，学习者只看到选安装位置、安装、完成三页。
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; 每次安装，electron-builder 都把安装程序本身复制一份到 %LOCALAPPDATA%\repa-desktop-updater\installer.exe，
; 供 electron-updater 做增量更新。Repa 不用自动更新，这一份与安装程序一样大（约 150 MB），而且不论装在哪里都留在 C 盘、
; 卸载也不删，所以装完就删掉它。
!macro customInstall
  Push $R0
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $R0
  RMDir "$R0"
  Pop $R0
!macroend
