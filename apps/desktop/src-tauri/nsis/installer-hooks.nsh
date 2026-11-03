!macro NSIS_HOOK_POSTINSTALL
  ; The installer page records intent only. Downloads run in Seamind after the user sees progress.
  ${If} $UpdateMode <> 1
    CreateDirectory "$LOCALAPPDATA\Seamind"
    ${If} $SeamindJavaSelected = ${BST_CHECKED}
      StrCpy $R8 "true"
    ${Else}
      StrCpy $R8 "false"
    ${EndIf}
    ${If} $SeamindYtDlpSelected = ${BST_CHECKED}
      StrCpy $R9 "true"
    ${Else}
      StrCpy $R9 "false"
    ${EndIf}
    ${If} "$R8$R9" == "falsefalse"
      Delete "$LOCALAPPDATA\Seamind\pending-components.json"
    ${Else}
      FileOpen $R7 "$LOCALAPPDATA\Seamind\pending-components.json" w
      FileWrite $R7 "{$\"plantumlJava$\":$R8,$\"ytDlp$\":$R9}"
      FileClose $R7
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri's built-in "delete local data" checkbox defaults to off and is skipped for updates.
  ; The pending file is installation intent, not user data, so discard it on every normal uninstall.
  ${If} $UpdateMode <> 1
    Delete "$LOCALAPPDATA\Seamind\pending-components.json"
    ${If} $DeleteAppDataCheckboxState = 1
      ; Remove only component paths owned by Seamind. Preserve other tools in the shared folder.
      Delete "$LOCALAPPDATA\Seamind\tools\yt-dlp.exe"
      RMDir /r "$LOCALAPPDATA\Seamind\tools\java"
      RMDir "$LOCALAPPDATA\Seamind\tools"
    ${EndIf}
    RMDir "$LOCALAPPDATA\Seamind"
  ${EndIf}
!macroend
