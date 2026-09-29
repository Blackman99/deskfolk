; NSIS hooks for the Windows installer (tauri.windows.conf.json → bundle.windows.nsis.installerHooks).
;
; The daemon and the terminal helper run from $INSTDIR\native, and a running exe can be neither
; overwritten nor deleted. While the window runs they sit in its Job Object: Tauri's own
; CheckIfAppIsRunning (right after these hooks) closes the window, asking first unless silent,
; and waits 500ms, and the Job Object takes them down with it. What that misses is a copy with no
; window left over it — one whose window crashed or was killed while it was starting, or one from
; a build that predates the Job Object. With no window running, nothing will start them again, so
; they are stopped here before any file is touched.

!macro DESKFOLK_STOP_ORPHANED_RUNTIME
  nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $R0
  ${If} $R0 != 0
    nsis_tauri_utils::KillProcessCurrentUser "real-bot-daemon.exe"
    Pop $R0
    nsis_tauri_utils::KillProcessCurrentUser "real-bot-pty.exe"
    Pop $R0
    Sleep 500
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro DESKFOLK_STOP_ORPHANED_RUNTIME
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro DESKFOLK_STOP_ORPHANED_RUNTIME
!macroend
