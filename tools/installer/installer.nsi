; ---------------------------------------------------------------------------
; 快捷文件分发服务@JIE —— Go 版安装器（NSIS）
;
; 为什么还要套一层安装器：Go 编译出来的是单个 exe，双击就能跑，本来不需要安装。
; 但直接丢一个 exe 给用户，就既没有开始菜单 / 桌面快捷方式，也没有
; 「添加或删除程序」里的卸载入口 —— 那不是 Windows 用户期待的软件形态。
; 这一层只做三件事：放文件、建快捷方式、登记卸载入口。
;
; 构建（命令与本机路径见同目录的 build.sh）：
;   makensis.exe /DVERSION=2.8.0-go /DVERSION_NUM=2.8.0.0 \
;                /DSRC_EXE=<Go 编译出的 exe> /DOUT_DIR=<输出目录> \
;                /DICON_FILE=<icon.ico> /DLICENSE_FILE=<LICENSE> installer.nsi
;
; 内部用的两个命令行开关（用户不用管）：
;   /ALLUSERS      本次按「所有用户」装 —— 提权后第二次运行带上它
;   /CURRENTUSER   本次按「仅当前用户」装
;
; 两个容易踩的坑，改这个文件时别忘了：
;   1. 脚本必须存成 **UTF-8 带 BOM**。不然 makensis 按系统代码页（中文系统是 GBK）
;      解释，上面这些中文全变成乱码。
;   2. 判断有没有管理员权限**不能只看 UserInfo::GetAccountType** —— 那个只问
;      「是不是管理员组成员」，UAC 下没提权的管理员也会回 Admin，照它装 Program Files
;      会静默失败。这里改成往 HKLM 写一个探针键看有没有报错，是真权限检查。
;      （因为 RequestExecutionLevel 写了清单，注册表虚拟化是关的，探针可信。）
; ---------------------------------------------------------------------------

!ifndef VERSION
  !define VERSION      "0.0.0"
!endif
!ifndef VERSION_NUM
  !define VERSION_NUM  "0.0.0.0"
!endif
!ifndef SRC_EXE
  !define SRC_EXE      "..\..\dist-go\QuickFileDispatch.exe"
!endif
!ifndef OUT_DIR
  !define OUT_DIR      "..\..\dist-go"
!endif
!ifndef ICON_FILE
  !define ICON_FILE    "..\..\build\icon.ico"
!endif
!ifndef LICENSE_FILE
  !define LICENSE_FILE "..\..\LICENSE"
!endif

!define APP_NAME   "快捷文件分发服务@JIE"
!define APP_EXE    "快捷文件分发服务@JIE.exe"
!define PUBLISHER  "小杰"
!define HOMEPAGE   "https://www.yangjie.site"
!define ARP_KEY    "Software\Microsoft\Windows\CurrentVersion\Uninstall\QuickFileDispatch-Go"
!define PROBE_KEY  "Software\QuickFileDispatch-Probe"
; WM_CLOSE 不用自己定义：MUI2.nsh 会把 WinMessages.nsh 一起拉进来，
; 里面已经有 WM_CLOSE，再写一遍会报 "already defined"

Unicode true
; 默认普通权限（asInvoker）：只有用户选「所有用户」时才以 runas 提权重开自己，
; 不给只想装给自己用的人弹一次没必要的 UAC
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
SetOverwrite on
SetDateSave on
CRCCheck on
; SetRegView 只能写在 section / function 里，所以放到 .onInit 和 un.onInit 去

Name "${APP_NAME} ${VERSION}"
OutFile "${OUT_DIR}\QuickFileDispatch-Setup-${VERSION}.exe"
BrandingText "${APP_NAME}"

VIProductVersion "${VERSION_NUM}"
VIAddVersionKey "ProductName"     "${APP_NAME}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "CompanyName"     "${PUBLISHER}"
VIAddVersionKey "LegalCopyright"  "Copyright (c) 2026 ${PUBLISHER}"

!define MUI_ICON   "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 ${APP_NAME}"

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var Scope               ; "current" | "all"
Var ScopeRadio_Current
Var ScopeRadio_All

; ------------------------------------------------------------------ 页面

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
Page custom ScopePage ScopePageLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; ------------------------------------------------------------------ 初始化

Function .onInit
  ; 64 位视图：安装器是 32 位程序，不设这个会写到 WOW6432Node 去
  SetRegView 64
  StrCpy $Scope "current"

  ; 提权后的第二次运行会带 /ALLUSERS 进来，这里认出来
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/ALLUSERS" $R1
  ${IfNot} ${Errors}
    StrCpy $Scope "all"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/CURRENTUSER" $R1
  ${IfNot} ${Errors}
    StrCpy $Scope "current"
  ${EndIf}

  ${If} $Scope == "all"
    ; 走到这里却还没拿到管理员权限（比如有人手动加了参数又取消了 UAC），
    ; 那就退回仅当前用户，别装到一半失败
    Call HasAdminRights
    ${If} $0 == 0
      StrCpy $Scope "current"
    ${EndIf}
  ${EndIf}

  Call ApplyScope
FunctionEnd

; 按范围决定默认安装目录和快捷方式写到哪儿
;   仅当前用户 → %LOCALAPPDATA%\Programs\  不需要管理员
;   所有用户   → Program Files            需要管理员
; $INSTDIR 非空说明命令行带了 /D=...，那就尊重用户指定的，别用默认值覆盖
Function ApplyScope
  ${If} $INSTDIR != ""
    ${If} $Scope == "all"
      SetShellVarContext all
    ${Else}
      SetShellVarContext current
    ${EndIf}
    Return
  ${EndIf}
  ${If} $Scope == "all"
    StrCpy $INSTDIR "$PROGRAMFILES64\${APP_NAME}"
    SetShellVarContext all
  ${Else}
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_NAME}"
    SetShellVarContext current
  ${EndIf}
FunctionEnd

; 真权限检查：往 HKLM 写个探针键，写不进去就是没提权
Function HasAdminRights
  ClearErrors
  WriteRegStr HKLM "${PROBE_KEY}" "Probe" "1"
  ${If} ${Errors}
    StrCpy $0 0
  ${Else}
    DeleteRegKey HKLM "${PROBE_KEY}"
    StrCpy $0 1
  ${EndIf}
FunctionEnd

; ------------------------------------------------------------------ 选择安装范围

Function ScopePage
  !insertmacro MUI_HEADER_TEXT "选择安装范围" "决定这个程序只给你用，还是给这台电脑上的所有用户用"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateRadioButton} 0 0 100% 12u "仅安装给当前用户（不需要管理员权限）"
  Pop $ScopeRadio_Current
  ${NSD_CreateRadioButton} 0 16u 100% 12u "安装给所有用户（需要管理员权限）"
  Pop $ScopeRadio_All

  ${NSD_CreateLabel} 0 36u 100% 40u \
    "选「仅当前用户」：装到当前用户的应用程序目录，不用弹权限确认，卸载也干净。$\r$\n\
选「所有用户」：装到 Program Files，这台电脑上的每个账户都能用，$\r$\n\
安装时会弹一次系统权限确认。$\r$\n$\r$\n\
两种装法共用同一份本机配置（%APPDATA%\Quick-FileDispatch）。"
  Pop $0

  ${If} $Scope == "all"
    ${NSD_Check} $ScopeRadio_All
  ${Else}
    ${NSD_Check} $ScopeRadio_Current
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function ScopePageLeave
  ; 静默安装（/S）时自定义页的 create 不会跑，两个单选按钮的句柄是空的，
  ; 再去读状态没意义 —— 直接用 .onInit 里从命令行认出来的范围
  ${If} ${Silent}
    Goto done
  ${EndIf}

  ${NSD_GetState} $ScopeRadio_All $1
  ${If} $1 == ${BST_CHECKED}
    StrCpy $Scope "all"
    Call HasAdminRights
    ${If} $0 == 0
      ; 还没提权 → 以 runas 重开自己，并把范围传过去；当前这个实例直接退出
      MessageBox MB_ICONINFORMATION|MB_OKCANCEL \
        "为所有用户安装需要管理员权限。$\r$\n$\r$\n点「确定」后会弹出系统权限确认；点「取消」则改为只安装给当前用户。" \
        /SD IDOK IDOK elevate
      StrCpy $Scope "current"
      Call ApplyScope
      Goto done
elevate:
      ExecShell "runas" "$EXEPATH" "/ALLUSERS"
      Quit
    ${EndIf}
  ${Else}
    StrCpy $Scope "current"
  ${EndIf}
done:
  Call ApplyScope
FunctionEnd

; ------------------------------------------------------------------ 卸载入口

!macro _WriteArp ROOT
  WriteRegStr   ${ROOT} "${ARP_KEY}" "DisplayName"          "${APP_NAME} ${VERSION}"
  WriteRegStr   ${ROOT} "${ARP_KEY}" "UninstallString"      '"$INSTDIR\uninstall.exe"'
  WriteRegStr   ${ROOT} "${ARP_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr   ${ROOT} "${ARP_KEY}" "InstallLocation"      "$INSTDIR"
  WriteRegStr   ${ROOT} "${ARP_KEY}" "DisplayIcon"          "$INSTDIR\${APP_EXE},0"
  WriteRegStr   ${ROOT} "${ARP_KEY}" "DisplayVersion"       "${VERSION}"
  WriteRegStr   ${ROOT} "${ARP_KEY}" "Publisher"            "${PUBLISHER}"
  WriteRegStr   ${ROOT} "${ARP_KEY}" "URLInfoAbout"         "${HOMEPAGE}"
  WriteRegStr   ${ROOT} "${ARP_KEY}" "InstallScope"         "$Scope"
  WriteRegDWORD ${ROOT} "${ARP_KEY}" "NoModify"             1
  WriteRegDWORD ${ROOT} "${ARP_KEY}" "NoRepair"             1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD ${ROOT} "${ARP_KEY}" "EstimatedSize"        "$0"
!macroend

; ------------------------------------------------------------------ 安装

Section "主程序" SEC_MAIN
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; 正在跑的话先请它退出，不然 exe 被占用，覆盖会失败
  FindWindow $0 "" "${APP_NAME}"
  ${If} $0 != 0
    SendMessage $0 ${WM_CLOSE} 0 0
    Sleep 1200
  ${EndIf}

  File "/oname=${APP_EXE}" "${SRC_EXE}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ${If} $Scope == "all"
    !insertmacro _WriteArp HKLM
  ${Else}
    !insertmacro _WriteArp HKCU
  ${EndIf}

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
SectionEnd

; ------------------------------------------------------------------ 卸载

Function un.onInit
  SetRegView 64
  ; 当初是按哪个范围装的？HKLM 里有键就是「所有用户」
  ClearErrors
  ReadRegStr $0 HKLM "${ARP_KEY}" "InstallScope"
  ${If} ${Errors}
    StrCpy $Scope "current"
    SetShellVarContext current
  ${Else}
    StrCpy $Scope "all"
    SetShellVarContext all
  ${EndIf}

  ; 装到 Program Files 的，卸载同样要权限；没有就提权重开卸载程序。
  ; 静默卸载（控制面板点「卸载」走的是 /S）不能弹框，直接放弃并退出 ——
  ; 否则用户点一下什么反应都没有，反而更困惑
  ${If} $Scope == "all"
    ClearErrors
    WriteRegStr HKLM "${PROBE_KEY}" "Probe" "1"
    ${If} ${Errors}
      ${If} ${Silent}
        Quit
      ${EndIf}
      MessageBox MB_ICONINFORMATION|MB_OKCANCEL \
        "卸载「为所有用户安装」的程序需要管理员权限。$\r$\n$\r$\n点「确定」后弹出系统权限确认；点「取消」则退出卸载。" \
        /SD IDCANCEL IDOK elevate
      Quit
elevate:
      ExecShell "runas" "$EXEPATH"
      Quit
    ${Else}
      DeleteRegKey HKLM "${PROBE_KEY}"
    ${EndIf}
  ${EndIf}

  ; 确认框只在有界面的时候问。静默模式下不弹，直接往下卸 ——
  ; MB_DEFBUTTON2 的默认是「否」，弹不出来就会被当成「不卸载」
  ${IfNot} ${Silent}
    MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 \
      "确定要卸载 ${APP_NAME} 吗？$\r$\n$\r$\n你的本机配置（仓库、Token、链接规则）不会被删除，$\r$\n以后重装可以直接接着用。" \
      /SD IDYES IDYES +2
    Quit
  ${EndIf}
FunctionEnd

Section "Uninstall"
  FindWindow $0 "" "${APP_NAME}"
  ${If} $0 != 0
    SendMessage $0 ${WM_CLOSE} 0 0
    Sleep 1200
  ${EndIf}

  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir  "$SMPROGRAMS\${APP_NAME}"

  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir  "$INSTDIR"

  ${If} $Scope == "all"
    DeleteRegKey HKLM "${ARP_KEY}"
  ${Else}
    DeleteRegKey HKCU "${ARP_KEY}"
  ${EndIf}
SectionEnd
