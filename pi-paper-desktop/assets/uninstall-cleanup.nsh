; Remove only Pi-Paper registration keys that still prove ownership by this install.
; The stock NSIS uninstaller already attempts these removals; its success callback
; verifies file removal and retries only registrations owned by this installation.

!ifdef BUILD_UNINSTALLER
!ifndef VIBEPAPER_UNINSTALL_CLEANUP_INCLUDED
  !define VIBEPAPER_UNINSTALL_CLEANUP_INCLUDED

  Var VPUC_ENTRY_ERRORS
  Var VPUC_FAILURE_REASON
  Var VPUC_INSTALL_LOCATION
  Var VPUC_UNINSTALL_STRING
  Var VPUC_DISPLAY_ICON
  Var VPUC_EXTRA_LOCATION
  Var VPUC_EXPECTED_UNINSTALL
  Var VPUC_PATH_LEFT
  Var VPUC_PATH_RIGHT
  Var VPUC_PATH_MATCH
  Var VPUC_PATH_LENGTH
  Var VPUC_PATH_LAST_CHAR
  Var VPUC_KEY_ABSENT
  Var VPUC_KEY_STATE
  Var VPUC_IS_UPDATED
  Var VPUC_VERIFIED

  !ifdef APP_64
    !define VPUC_REGISTRY_VIEW 64
    !define VPUC_REGISTRY_READ_ACCESS 0x20119
  !else
    !define VPUC_REGISTRY_VIEW 32
    !define VPUC_REGISTRY_READ_ACCESS 0x20219
  !endif

  !macro VPUC_SAVE_STATE suffix
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $R6
    Push $R7
    Push $R8
    Push $R9
    StrCpy $VPUC_ENTRY_ERRORS "false"
    IfErrors vpuc_entry_error_${suffix}
    Goto vpuc_entry_saved_${suffix}
    vpuc_entry_error_${suffix}:
      StrCpy $VPUC_ENTRY_ERRORS "true"
    vpuc_entry_saved_${suffix}:
    ClearErrors
  !macroend

  !macro VPUC_RESTORE_STATE suffix
    Pop $R9
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    Pop $9
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
    StrCmp $VPUC_ENTRY_ERRORS "true" vpuc_restore_error_${suffix} vpuc_restore_clear_${suffix}
    vpuc_restore_error_${suffix}:
      SetErrors
      Goto vpuc_restore_done_${suffix}
    vpuc_restore_clear_${suffix}:
      ClearErrors
    vpuc_restore_done_${suffix}:
  !macroend

  ; Compare two paths after Windows lexical normalization. A trailing separator is
  ; ignored except for a drive root; comparison is case-insensitive but exact.
  !macro VPUC_PATH_MATCHES_INSTALL candidate suffix
    StrCpy $VPUC_PATH_MATCH "false"
    StrCpy $VPUC_PATH_LEFT ""
    StrCpy $VPUC_PATH_RIGHT ""
    ; Require a fully qualified drive/UNC path. Relative registry values cannot
    ; prove ownership using the uninstaller's incidental working directory.
    StrCpy $2 "${candidate}"
    StrCpy $0 $2 2
    StrCmp $0 "\\" vpuc_path_absolute_${suffix}
    StrCpy $0 $2 1 1
    StrCmp $0 ":" 0 vpuc_path_done_${suffix}
    StrCpy $0 $2 1 2
    StrCmp $0 "\" vpuc_path_absolute_${suffix}
    StrCmp $0 "/" 0 vpuc_path_done_${suffix}
    vpuc_path_absolute_${suffix}:
    ; NSIS GetFullPathName can set its error flag for a nonexistent directory.
    ; Stock cleanup has already removed INSTDIR: use the lexical Win32 API so
    ; ownership matching does not depend on the deleted directory existing.
    StrCpy $1 0
    System::Call 'kernel32::GetFullPathNameW(w r2, i ${NSIS_MAX_STRLEN}, w .r0, p 0) i.r1'
    ${If} $1 == 0
    ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
      Goto vpuc_path_done_${suffix}
    ${EndIf}
    StrCpy $VPUC_PATH_LEFT $0
    StrCpy $2 "$INSTDIR"
    StrCpy $1 0
    System::Call 'kernel32::GetFullPathNameW(w r2, i ${NSIS_MAX_STRLEN}, w .r0, p 0) i.r1'
    ${If} $1 == 0
    ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
      Goto vpuc_path_done_${suffix}
    ${EndIf}
    StrCpy $VPUC_PATH_RIGHT $0

    StrLen $VPUC_PATH_LENGTH $VPUC_PATH_LEFT
    ${If} $VPUC_PATH_LENGTH > 3
      StrCpy $VPUC_PATH_LAST_CHAR $VPUC_PATH_LEFT 1 -1
      StrCmp $VPUC_PATH_LAST_CHAR "\" vpuc_trim_left_${suffix} vpuc_trim_left_done_${suffix}
      vpuc_trim_left_${suffix}:
        IntOp $VPUC_PATH_LENGTH $VPUC_PATH_LENGTH - 1
        StrCpy $VPUC_PATH_LEFT $VPUC_PATH_LEFT $VPUC_PATH_LENGTH
      vpuc_trim_left_done_${suffix}:
    ${EndIf}

    StrLen $VPUC_PATH_LENGTH $VPUC_PATH_RIGHT
    ${If} $VPUC_PATH_LENGTH > 3
      StrCpy $VPUC_PATH_LAST_CHAR $VPUC_PATH_RIGHT 1 -1
      StrCmp $VPUC_PATH_LAST_CHAR "\" vpuc_trim_right_${suffix} vpuc_trim_right_done_${suffix}
      vpuc_trim_right_${suffix}:
        IntOp $VPUC_PATH_LENGTH $VPUC_PATH_LENGTH - 1
        StrCpy $VPUC_PATH_RIGHT $VPUC_PATH_RIGHT $VPUC_PATH_LENGTH
      vpuc_trim_right_done_${suffix}:
    ${EndIf}

    ; NSIS StrCmp is case-insensitive by default, and compares the full strings.
    StrCmp $VPUC_PATH_LEFT $VPUC_PATH_RIGHT vpuc_path_match_${suffix} vpuc_path_done_${suffix}
    vpuc_path_match_${suffix}:
      StrCpy $VPUC_PATH_MATCH "true"
    vpuc_path_done_${suffix}:
    ClearErrors
  !macroend

  ; Use RegOpenKeyExW in the package's explicit registry view. Win32 distinguishes
  ; absent keys (FILE_NOT_FOUND / PATH_NOT_FOUND) from access and other failures.
  !macro VPUC_READ_KEY_STATE hive_handle key suffix
    StrCpy $VPUC_KEY_STATE "error"
    ClearErrors
    StrCpy $0 0
    StrCpy $1 0
    System::Call 'advapi32::RegOpenKeyExW(p ${hive_handle}, w "${key}", i 0, i ${VPUC_REGISTRY_READ_ACCESS}, *p .r0) i.r1'
    StrCmp $1 "0" vpuc_key_opened_${suffix}
    StrCmp $1 "2" vpuc_key_state_absent_${suffix}
    StrCmp $1 "3" vpuc_key_state_absent_${suffix}
    Goto vpuc_key_state_done_${suffix}
    vpuc_key_opened_${suffix}:
      StrCpy $VPUC_KEY_STATE "present"
      System::Call 'advapi32::RegCloseKey(p r0) i.r1'
      StrCmp $1 "0" vpuc_key_state_done_${suffix}
      StrCpy $VPUC_KEY_STATE "error"
      Goto vpuc_key_state_done_${suffix}
    vpuc_key_state_absent_${suffix}:
      StrCpy $VPUC_KEY_STATE "absent"
    vpuc_key_state_done_${suffix}:
      ClearErrors
  !macroend

  !macro VPUC_VERIFY_KEY_ABSENT hive_handle key suffix
    StrCpy $VPUC_KEY_ABSENT "false"
    !insertmacro VPUC_READ_KEY_STATE ${hive_handle} "${key}" ${suffix}_state
    StrCmp $VPUC_KEY_STATE "absent" vpuc_verify_absent_${suffix}
    StrCpy $VPUC_KEY_ABSENT "false"
    Goto vpuc_verify_done_${suffix}
    vpuc_verify_absent_${suffix}:
      StrCpy $VPUC_KEY_ABSENT "true"
    vpuc_verify_done_${suffix}:
      ClearErrors
  !macroend

  !macro VPUC_DELETE_OWNED_INSTALL_KEY hive hive_handle suffix
    !insertmacro VPUC_READ_KEY_STATE ${hive_handle} "${INSTALL_REGISTRY_KEY}" ${suffix}_state
    StrCmp $VPUC_KEY_STATE "absent" vpuc_install_missing_${suffix}
    StrCmp $VPUC_KEY_STATE "present" vpuc_install_read_${suffix} vpuc_install_check_failed_${suffix}
    vpuc_install_read_${suffix}:
    ClearErrors
    ReadRegStr $VPUC_INSTALL_LOCATION ${hive} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    IfErrors vpuc_install_missing_${suffix} vpuc_install_value_present_${suffix}
    vpuc_install_value_present_${suffix}:
      StrCmp $VPUC_INSTALL_LOCATION "" vpuc_install_unowned_${suffix}
      !insertmacro VPUC_PATH_MATCHES_INSTALL "$VPUC_INSTALL_LOCATION" ${suffix}_path
      StrCmp $VPUC_PATH_MATCH "true" vpuc_install_owned_${suffix} vpuc_install_unowned_${suffix}
    vpuc_install_owned_${suffix}:
      ClearErrors
      DeleteRegKey ${hive} "${INSTALL_REGISTRY_KEY}"
      IfErrors vpuc_install_delete_failed_${suffix}
      !insertmacro VPUC_VERIFY_KEY_ABSENT ${hive_handle} "${INSTALL_REGISTRY_KEY}" ${suffix}_verify
      StrCmp $VPUC_KEY_ABSENT "true" vpuc_install_removed_${suffix} vpuc_install_delete_failed_${suffix}
    vpuc_install_removed_${suffix}:
      DetailPrint "Removed the Pi-Paper install registration for this installation."
      Goto vpuc_install_done_${suffix}
    vpuc_install_delete_failed_${suffix}:
      StrCmp $VPUC_FAILURE_REASON "" 0 +2
      StrCpy $VPUC_FAILURE_REASON "A Pi-Paper registry entry matched this installation but could not be removed."
      Goto vpuc_install_done_${suffix}
    vpuc_install_missing_${suffix}:
      ClearErrors
      Goto vpuc_install_done_${suffix}
    vpuc_install_check_failed_${suffix}:
      StrCmp $VPUC_FAILURE_REASON "" 0 +2
      StrCpy $VPUC_FAILURE_REASON "Pi-Paper registration could not be safely checked for this installation."
      Goto vpuc_install_done_${suffix}
    vpuc_install_unowned_${suffix}:
      ClearErrors
      DetailPrint "Kept a Pi-Paper install registration because it did not match this installation."
    vpuc_install_done_${suffix}:
  !macroend

  !macro VPUC_DELETE_OWNED_UNINSTALL_KEY hive hive_handle mode suffix
    !insertmacro VPUC_READ_KEY_STATE ${hive_handle} "${UNINSTALL_REGISTRY_KEY}" ${suffix}_state
    StrCmp $VPUC_KEY_STATE "absent" vpuc_uninstall_missing_${suffix}
    StrCmp $VPUC_KEY_STATE "present" vpuc_uninstall_read_${suffix} vpuc_uninstall_check_failed_${suffix}
    vpuc_uninstall_read_${suffix}:
    ClearErrors
    ReadRegStr $VPUC_UNINSTALL_STRING ${hive} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    IfErrors vpuc_uninstall_unowned_${suffix} vpuc_uninstall_string_present_${suffix}
    vpuc_uninstall_string_present_${suffix}:
      ClearErrors
      ReadRegStr $VPUC_DISPLAY_ICON ${hive} "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon"
      IfErrors vpuc_uninstall_unowned_${suffix} vpuc_uninstall_icon_present_${suffix}
    vpuc_uninstall_icon_present_${suffix}:
      StrCpy $VPUC_EXPECTED_UNINSTALL `"$INSTDIR\${UNINSTALL_FILENAME}" /${mode}`
      StrCmp $VPUC_UNINSTALL_STRING $VPUC_EXPECTED_UNINSTALL vpuc_uninstall_command_matches_${suffix} vpuc_uninstall_unowned_${suffix}
    vpuc_uninstall_command_matches_${suffix}:
      StrCmp $VPUC_DISPLAY_ICON "$INSTDIR\${APP_EXECUTABLE_FILENAME},0" vpuc_uninstall_icon_matches_${suffix} vpuc_uninstall_unowned_${suffix}
    vpuc_uninstall_icon_matches_${suffix}:
      ; Some versions may add InstallLocation to the uninstall key. If present,
      ; require an exact normalized path match as an additional ownership proof.
      ClearErrors
      ReadRegStr $VPUC_EXTRA_LOCATION ${hive} "${UNINSTALL_REGISTRY_KEY}" "InstallLocation"
      IfErrors vpuc_uninstall_location_missing_${suffix} vpuc_uninstall_location_present_${suffix}
    vpuc_uninstall_location_present_${suffix}:
      !insertmacro VPUC_PATH_MATCHES_INSTALL "$VPUC_EXTRA_LOCATION" ${suffix}_extra_path
      StrCmp $VPUC_PATH_MATCH "true" vpuc_uninstall_owned_${suffix} vpuc_uninstall_unowned_${suffix}
    vpuc_uninstall_location_missing_${suffix}:
      ClearErrors
      Goto vpuc_uninstall_owned_${suffix}
    vpuc_uninstall_owned_${suffix}:
      ClearErrors
      DeleteRegKey ${hive} "${UNINSTALL_REGISTRY_KEY}"
      IfErrors vpuc_uninstall_delete_failed_${suffix}
      !insertmacro VPUC_VERIFY_KEY_ABSENT ${hive_handle} "${UNINSTALL_REGISTRY_KEY}" ${suffix}_verify
      StrCmp $VPUC_KEY_ABSENT "true" vpuc_uninstall_removed_${suffix} vpuc_uninstall_delete_failed_${suffix}
    vpuc_uninstall_removed_${suffix}:
      DetailPrint "Removed the Pi-Paper uninstall registration for this installation."
      Goto vpuc_uninstall_done_${suffix}
    vpuc_uninstall_delete_failed_${suffix}:
      StrCmp $VPUC_FAILURE_REASON "" 0 +2
      StrCpy $VPUC_FAILURE_REASON "A Pi-Paper registry entry matched this installation but could not be removed."
      Goto vpuc_uninstall_done_${suffix}
    vpuc_uninstall_unowned_${suffix}:
      ClearErrors
      DetailPrint "Kept a Pi-Paper uninstall registration because it did not match this installation."
      Goto vpuc_uninstall_done_${suffix}
    vpuc_uninstall_missing_${suffix}:
      ClearErrors
      Goto vpuc_uninstall_done_${suffix}
    vpuc_uninstall_check_failed_${suffix}:
      StrCmp $VPUC_FAILURE_REASON "" 0 +2
      StrCpy $VPUC_FAILURE_REASON "Pi-Paper registration could not be safely checked for this installation."
      Goto vpuc_uninstall_done_${suffix}
    vpuc_uninstall_done_${suffix}:
  !macroend

  !macro VPUC_CLEANUP_HIVE hive hive_handle mode suffix
    !insertmacro VPUC_DELETE_OWNED_INSTALL_KEY ${hive} ${hive_handle} ${suffix}_install
    !insertmacro VPUC_DELETE_OWNED_UNINSTALL_KEY ${hive} ${hive_handle} ${mode} ${suffix}_uninstall
  !macroend

  !macro VPUC_CLEANUP_REGISTRATION_KEYS suffix
    !insertmacro VPUC_SAVE_STATE ${suffix}
    SetRegView ${VPUC_REGISTRY_VIEW}
    StrCpy $VPUC_FAILURE_REASON ""
    StrCmp $installMode "CurrentUser" vpuc_mode_current_${suffix} vpuc_mode_check_all_${suffix}
    vpuc_mode_current_${suffix}:
      !insertmacro VPUC_CLEANUP_HIVE HKCU 0x80000001 currentuser ${suffix}_current
      Goto vpuc_mode_done_${suffix}
    vpuc_mode_check_all_${suffix}:
      StrCmp $installMode "all" vpuc_mode_all_${suffix} vpuc_mode_invalid_${suffix}
    vpuc_mode_all_${suffix}:
      !insertmacro VPUC_CLEANUP_HIVE HKLM 0x80000002 allusers ${suffix}_all
      Goto vpuc_mode_done_${suffix}
    vpuc_mode_invalid_${suffix}:
      StrCpy $VPUC_FAILURE_REASON "The installation scope could not be determined, so its registrations were left untouched."
    vpuc_mode_done_${suffix}:
      StrCmp $VPUC_FAILURE_REASON "" vpuc_cleanup_success_${suffix} vpuc_cleanup_failure_${suffix}
    vpuc_cleanup_failure_${suffix}:
      !insertmacro VPUC_RESTORE_STATE ${suffix}_failed
      MessageBox MB_OK|MB_ICONSTOP "Pi-Paper could not finish uninstalling. Please retry or reinstall the app." /SD IDOK
      SetErrorLevel 2
      Quit
    vpuc_cleanup_success_${suffix}:
      !insertmacro VPUC_RESTORE_STATE ${suffix}_success
  !macroend

  !macro VPUC_VERIFY_INITIAL_TARGET suffix
    StrCmp $VPUC_IS_UPDATED "true" vpuc_initial_target_present_${suffix}
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" vpuc_initial_target_present_${suffix}
    IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" vpuc_initial_target_present_${suffix}
    MessageBox MB_OK|MB_ICONSTOP "Pi-Paper could not find this installation's program files. Reinstall the app before retrying uninstall." /SD IDOK
    SetErrorLevel 2
    Quit
    vpuc_initial_target_present_${suffix}:
  !macroend

  !macro customUnInit
    !ifmacrodef VPUC_BEFORE_INIT_CHECK
      !insertmacro VPUC_BEFORE_INIT_CHECK
    !endif
    !insertmacro VPUC_SAVE_STATE init_policy
    StrCpy $VPUC_IS_UPDATED "false"
    ${If} ${isUpdated}
      StrCpy $VPUC_IS_UPDATED "true"
    ${EndIf}
    !insertmacro VPUC_RESTORE_STATE init_policy
    !insertmacro VPUC_VERIFY_INITIAL_TARGET init_policy
  !macroend

  !macro VPUC_VERIFY_FILES_REMOVED suffix
    ; Updates use the stock atomic move/restore lifecycle and may run the
    ; registered uninstaller in place. The installer owns their final payload.
    StrCmp $VPUC_IS_UPDATED "true" vpuc_files_removed_${suffix}
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" vpuc_files_remain_${suffix}
    IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" vpuc_files_remain_${suffix} vpuc_files_removed_${suffix}
    vpuc_files_remain_${suffix}:
      MessageBox MB_OK|MB_ICONSTOP "Pi-Paper could not remove its program files. Close the app and retry uninstalling." /SD IDOK
      SetErrorLevel 2
      Quit
    vpuc_files_removed_${suffix}:
  !macroend

  ; The template expands this immediately before MUI_UNPAGE_FINISH. Its PRE
  ; callback validates before showing completion without adding another page.
  !macro customUninstallPage
    !define MUI_PAGE_CUSTOMFUNCTION_PRE un.VibePaperVerifyUninstall
  !macroend

  !macro customHeader
    Function un.VibePaperVerifyUninstall
      StrCmp $VPUC_VERIFIED "true" vpuc_already_verified
      StrCpy $VPUC_IS_UPDATED "false"
      ${If} ${isUpdated}
        StrCpy $VPUC_IS_UPDATED "true"
      ${EndIf}
      !insertmacro VPUC_VERIFY_FILES_REMOVED stock_success
      !insertmacro VPUC_CLEANUP_REGISTRATION_KEYS stock_success
      !ifmacrodef VPUC_AFTER_SUCCESS_CHECK
        !insertmacro VPUC_AFTER_SUCCESS_CHECK
      !endif
      StrCpy $VPUC_VERIFIED "true"
      vpuc_already_verified:
    FunctionEnd

    ; Silent uninstall has no page callbacks. Reuse the same validation before
    ; returning success; interactive uninstall has already verified at FINISH PRE.
    Function un.onUninstSuccess
      Call un.VibePaperVerifyUninstall
    FunctionEnd
  !macroend
!endif
!endif
