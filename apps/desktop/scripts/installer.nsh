; electron-builder 的 NSIS 安装程序在 oneClick 为 false 时，先问“为哪位用户安装”；选“所有用户”要管理员权限，并改装到 Program Files。
; Repa 只按当前用户安装，这里跳过那一页，学习者只看到选安装位置、安装、完成三页。见 package-win.mjs。
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
