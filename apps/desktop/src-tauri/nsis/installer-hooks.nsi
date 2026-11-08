; Modrex installer hooks
;
; Runs the existing uninstaller before installing new files, for an install left by the
; old Tauri identifier. Only that identifier is covered: electron-builder can register
; its uninstall entry under a generated GUID rather than the appId, so an Electron-era
; install is not reachable through this key.
; App data (%APPDATA%\modrex\) is never touched by the uninstaller.

; The template includes this file before it declares UpdateMode and defines
; MAINBINARYNAME, so .onInstFailed cannot read them. NSIS_HOOK_PREINSTALL sets the path
; only during a Nightly update, and ModrexBackedUp only once the exe was copied to the
; same path plus .bak. Both stay empty for every other install.
Var ModrexExePath
Var ModrexBackedUp

!macro NSIS_HOOK_PREINSTALL
    ; Handle old Tauri identifier (v0.4.0 – v0.9.x)
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\io.github.shulhaoleh.pd3modmanager" "UninstallString"
    ${If} $R0 != ""
        ExecWait '$R0 /S'
    ${EndIf}

    ; StrLoc is declared by the template and leaves $0 empty unless VERSION contains
    ; -nightly., so first installs, reinstalls and Stable updates skip the recovery below.
    ${StrLoc} $0 "${VERSION}" "-nightly." ">"
    ${If} $UpdateMode = 1
    ${AndIf} $0 != ""
        StrCpy $ModrexExePath "$INSTDIR\${MAINBINARYNAME}.exe"

        ; The updater exits the app right after starting this installer, and the
        ; template's next step force closes whatever uses the exe once and aborts if
        ; that fails (tauri issue 16277). Wait up to 20 seconds until nothing uses
        ; the exe and it opens for writing. A Restart Manager pass can take longer than
        ; the 250 ms sleep, so the limit is elapsed time rather than a pass count.
        System::Call 'kernel32::GetTickCount() i .R7'
        StrCpy $R9 0
        ${Do}
            StrCpy $0 0
            !insertmacro RestartManager_StartSession $R8
            ${If} $R8 != ""
                !insertmacro RestartManager_RegisterFile $R8 "$ModrexExePath"
                ${If} $0 = 0
                    System::Call 'RSTRTMGR::RmGetList(p R8, *i .r1, *i .r2, p 0, *i .r3) i .r0'
                ${EndIf}
                !insertmacro RestartManager_EndSession $R8
            ${EndIf}
            ${If} $0 <> ${ERROR_MORE_DATA}
                ClearErrors
                FileOpen $1 "$ModrexExePath" a
                ${IfNot} ${Errors}
                    FileClose $1
                    ${ExitDo}
                ${EndIf}
            ${EndIf}
            System::Call 'kernel32::GetTickCount() i .r1'
            IntOp $1 $1 - $R7
            ${IfThen} $1 >= 20000 ${|} ${ExitDo} ${|}
            ${IfThen} $R9 = 0 ${|} DetailPrint "Waiting for Modrex to close..." ${|}
            StrCpy $R9 1
            Sleep 250
        ${Loop}

        ; File truncates the exe before writing it, so a failure after that point
        ; leaves no runnable app. A copy rather than a rename keeps the exe in place
        ; for the template's running app check, and .onInstFailed restores it before
        ; relaunching. If the copy fails the update stops here, with the exe intact.
        ClearErrors
        CopyFiles /SILENT "$ModrexExePath" "$ModrexExePath.bak"
        ${If} ${Errors}
            Delete "$ModrexExePath.bak"
            Abort "Could not back up Modrex before updating it."
        ${EndIf}
        StrCpy $ModrexBackedUp 1
    ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
    ${If} $ModrexBackedUp = 1
        Delete "$ModrexExePath.bak"
    ${EndIf}
!macroend

; Passive installs reach this only when the user closes the failed installer.
Function .onInstFailed
    ${If} $ModrexExePath == ""
        Return
    ${EndIf}
    ${If} $ModrexBackedUp = 1
        ClearErrors
        Delete "$ModrexExePath"
        Rename "$ModrexExePath.bak" "$ModrexExePath"
        ${If} ${Errors}
            Return
        ${EndIf}
    ${EndIf}
    ${GetOptions} $CMDLINE "/R" $0
    ${If} ${Errors}
        Return
    ${EndIf}
    Exec '"$ModrexExePath"'
FunctionEnd
