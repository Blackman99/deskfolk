; The Windows installer of the native app (`scripts/package.ts --release` on Windows builds it with
; makensis). It takes the Tauri app's place the way the Mac's dmg does: the folder the uninstall
; entry records (`InstallLocation`: the Tauri app let you pick one; %LOCALAPPDATA%\Deskfolk
; otherwise), the same uninstall entry (HKCU ...\Uninstall\Deskfolk, the key Tauri's template
; writes), and the main program under the name that entry records (`MainBinaryName`), so the Start
; menu and desktop shortcuts, a taskbar pin and the launch at login keep pointing at a program that
; is there. The data folder (%LOCALAPPDATA%\real-bot) is never touched: conversations,
; settings and keys carry on.
;
; makensis /DVERSION=<x.y.z> /DSTAGE=<folder with Deskfolk.exe, app\, native\> /DOUTFILE=<setup.exe>

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define PRODUCTNAME "Deskfolk"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define DEFAULT_MAIN "Deskfolk.exe"

Name "${PRODUCTNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\${PRODUCTNAME}"
RequestExecutionLevel user
BrandingText "${PRODUCTNAME} ${VERSION}"
VIProductVersion "${FILEVERSION}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${FILEVERSION}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME} installer"
VIAddVersionKey "LegalCopyright" "MIT"

; The name the main program goes by in this folder: the one the uninstall entry records (a Tauri
; install's, or an earlier one of these), or Deskfolk.exe on a fresh machine.
Var MainName

!define MUI_ICON "${STAGE}\icon.ico"
!define MUI_UNICON "${STAGE}\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\$MainName"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

; Stops the app and what it started, the current user's only: the window asked to close first (it
; stops its daemon on the way out), then whatever is left ended. A running program can be neither
; overwritten nor deleted.
!macro STOP_DESKFOLK
  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM "$MainName"'
  Pop $0
  Sleep 2500
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "$MainName"'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "real-bot-daemon.exe"'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "real-bot-pty.exe"'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "real-bot-rtc.exe"'
  Pop $0
  Sleep 500
!macroend

Function .onInit
  ReadRegStr $MainName HKCU "${UNINSTKEY}" "MainBinaryName"
  ${If} $MainName == ""
    StrCpy $MainName "${DEFAULT_MAIN}"
  ${EndIf}
  ; Where the earlier install is, unless /D named a folder: both Tauri's template and this one write
  ; it in quotes.
  ${If} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
    ReadRegStr $0 HKCU "${UNINSTKEY}" "InstallLocation"
    StrCpy $1 $0 1
    ${If} $1 == '"'
      StrCpy $0 $0 "" 1
      StrCpy $0 $0 -1
    ${EndIf}
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\$MainName"
      StrCpy $INSTDIR $0
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  !insertmacro STOP_DESKFOLK
  ; What the Tauri app left that this one does not use; native\ is replaced as a whole.
  RMDir /r "$INSTDIR\native"
  RMDir /r "$INSTDIR\app"
  File "/oname=$INSTDIR\$MainName" "${STAGE}\Deskfolk.exe"
  File /r "${STAGE}\app"
  File /r "${STAGE}\native"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Kept as they are when they exist (a Tauri install's carry the app's id for the taskbar).
  ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$MainName"
  ${EndIf}
  ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$MainName"
  ${EndIf}

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" '"$INSTDIR\$MainName"'
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "Deskfolk"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" '"$INSTDIR"'
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "${UNINSTKEY}" "MainBinaryName" "$MainName"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" $0
SectionEnd

Function un.onInit
  ReadRegStr $MainName HKCU "${UNINSTKEY}" "MainBinaryName"
  ${If} $MainName == ""
    StrCpy $MainName "${DEFAULT_MAIN}"
  ${EndIf}
FunctionEnd

Section "Uninstall"
  !insertmacro STOP_DESKFOLK
  Delete "$INSTDIR\$MainName"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\native"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  ; Launch at login (`win_login.rs`; the Tauri app's autostart wrote the same value).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd
