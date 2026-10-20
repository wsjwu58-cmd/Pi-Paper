; Opt-in manual-acceptance diagnostics only. electron-builder includes this file only
; when VIBEPAPER_NSIS_UNINSTALL_DIAGNOSTICS_TEST_ONLY=1 is explicitly set.
; This file is intentionally observational: no registry/file writes or UI changes.

!include "uninstall-cleanup.nsh"

!ifdef BUILD_UNINSTALLER
  Var VPD_LOG_ENABLED
  Var VPD_LOG_HANDLE
  Var VPD_LOG_PATH
  Var VPD_ENTRY_ERRORS
  Var VPD_MODE
  Var VPD_SELECTED_LOCATION
  Var VPD_SELECTED_NORMALIZED
  Var VPD_INSTDIR_MATCH
  Var VPD_ARG_CURRENTUSER
  Var VPD_ARG_ALLUSERS
  Var VPD_ARG_D_MARKER
  Var VPD_ARG_UNINSTALLER_PATH_MARKER
  Var VPD_HKCU_INSTALL_KEY_HAS_VALUES
  Var VPD_HKLM_INSTALL_KEY_HAS_VALUES
  Var VPD_HKCU_INSTALLLOCATION
  Var VPD_HKLM_INSTALLLOCATION
  Var VPD_HKCU_UNINSTALL_KEY_HAS_VALUES
  Var VPD_HKLM_UNINSTALL_KEY_HAS_VALUES
  Var VPD_HKCU_UNINSTALLSTRING
  Var VPD_HKLM_UNINSTALLSTRING
  Var VPD_APP_EXE_EXISTS
  Var VPD_UNINSTALLER_EXISTS
  Var VPD_LINE

  ; Capture every NSIS register and the incoming error flag before diagnostics.
  !macro VPD_BEGIN suffix
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
    StrCpy $VPD_ENTRY_ERRORS "false"
    IfErrors vpd_entry_error_${suffix}
    Goto vpd_entry_saved_${suffix}
    vpd_entry_error_${suffix}:
      StrCpy $VPD_ENTRY_ERRORS "true"
    vpd_entry_saved_${suffix}:
    ClearErrors
  !macroend

  !macro VPD_END suffix
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
    StrCmp $VPD_ENTRY_ERRORS "true" vpd_restore_error_${suffix}
    ClearErrors
    Goto vpd_restore_done_${suffix}
    vpd_restore_error_${suffix}:
      SetErrors
    vpd_restore_done_${suffix}:
  !macroend

  !macro VPD_INIT_LOG suffix
    StrCpy $VPD_LOG_ENABLED "false"
    StrCpy $VPD_LOG_HANDLE "-1"
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy $VPD_LOG_PATH "$TEMP\VibePaper-UninstallDiag-$0.log"
    ; CREATE_NEW guarantees an existing per-PID log is never truncated or appended.
    System::Call 'kernel32::CreateFileW(w "$VPD_LOG_PATH", i 0x40000000, i 0, p 0, i 1, i 0x80, p 0) p.r1'
    StrCmp $1 "-1" vpd_log_unavailable_${suffix}
    StrCpy $VPD_LOG_HANDLE $1
    StrCpy $VPD_LOG_ENABLED "true"
    vpd_log_unavailable_${suffix}:
  !macroend

  !macro VPD_FIND_SUBSTRING output token length suffix
    StrCpy ${output} "false"
    StrLen $R2 $R0
    IntOp $R2 $R2 - ${length}
    StrCpy $R3 0
    vpd_scan_${suffix}:
      IntCmp $R3 $R2 vpd_scan_last_${suffix} vpd_scan_body_${suffix} vpd_scan_done_${suffix}
    vpd_scan_body_${suffix}:
      StrCpy $R4 $R0 ${length} $R3
      StrCmp $R4 "${token}" vpd_scan_found_${suffix}
      IntOp $R3 $R3 + 1
      Goto vpd_scan_${suffix}
    vpd_scan_last_${suffix}:
      StrCpy $R4 $R0 ${length} $R3
      StrCmp $R4 "${token}" vpd_scan_found_${suffix}
      Goto vpd_scan_done_${suffix}
    vpd_scan_found_${suffix}:
      StrCpy ${output} "true"
    vpd_scan_done_${suffix}:
  !macroend

  !macro VPD_CAPTURE_FLAGS suffix
    StrCpy $VPD_ARG_CURRENTUSER "false"
    StrCpy $VPD_ARG_ALLUSERS "false"
    StrCpy $VPD_ARG_D_MARKER "false"
    StrCpy $VPD_ARG_UNINSTALLER_PATH_MARKER "false"
    ${StdUtils.TestParameter} $R1 "currentuser"
    StrCmp $R1 "true" vpd_currentuser_found_${suffix}
    Goto vpd_currentuser_done_${suffix}
    vpd_currentuser_found_${suffix}:
      StrCpy $VPD_ARG_CURRENTUSER "true"
    vpd_currentuser_done_${suffix}:
    ${StdUtils.TestParameter} $R1 "allusers"
    StrCmp $R1 "true" vpd_allusers_found_${suffix}
    Goto vpd_allusers_done_${suffix}
    vpd_allusers_found_${suffix}:
      StrCpy $VPD_ARG_ALLUSERS "true"
    vpd_allusers_done_${suffix}:
    ; The complete argument text stays in $R0 only while searching; it is never logged.
    ${StdUtils.GetAllParameters} $R0 "0"
    !insertmacro VPD_FIND_SUBSTRING $VPD_ARG_D_MARKER "/D=" 3 ${suffix}_D
    !insertmacro VPD_FIND_SUBSTRING $VPD_ARG_UNINSTALLER_PATH_MARKER "_?=" 3 ${suffix}_UP
  !macroend

  !macro VPD_READ_NONEMPTY output hive key value suffix
    StrCpy ${output} "false"
    ClearErrors
    ReadRegStr $R0 ${hive} "${key}" "${value}"
    IfErrors vpd_reg_empty_${suffix}
    StrCmp $R0 "" vpd_reg_empty_${suffix}
    StrCpy ${output} "true"
    Goto vpd_reg_done_${suffix}
    vpd_reg_empty_${suffix}:
      StrCpy ${output} "false"
    vpd_reg_done_${suffix}:
    ClearErrors
  !macroend

  !macro VPD_KEY_HAS_VALUES output hive key suffix
    StrCpy ${output} "false"
    ClearErrors
    EnumRegValue $R0 ${hive} "${key}" 0
    IfErrors vpd_key_empty_${suffix}
    StrCpy ${output} "true"
    Goto vpd_key_done_${suffix}
    vpd_key_empty_${suffix}:
      StrCpy ${output} "false"
    vpd_key_done_${suffix}:
    ClearErrors
  !macroend

  !macro VPD_CAPTURE_REGISTRY suffix
    !insertmacro VPD_KEY_HAS_VALUES $VPD_HKCU_INSTALL_KEY_HAS_VALUES HKCU ${INSTALL_REGISTRY_KEY} ${suffix}_hki
    !insertmacro VPD_KEY_HAS_VALUES $VPD_HKLM_INSTALL_KEY_HAS_VALUES HKLM ${INSTALL_REGISTRY_KEY} ${suffix}_hmi
    !insertmacro VPD_READ_NONEMPTY $VPD_HKCU_INSTALLLOCATION HKCU ${INSTALL_REGISTRY_KEY} InstallLocation ${suffix}_hki
    !insertmacro VPD_READ_NONEMPTY $VPD_HKLM_INSTALLLOCATION HKLM ${INSTALL_REGISTRY_KEY} InstallLocation ${suffix}_hmi
    !insertmacro VPD_KEY_HAS_VALUES $VPD_HKCU_UNINSTALL_KEY_HAS_VALUES HKCU ${UNINSTALL_REGISTRY_KEY} ${suffix}_hku
    !insertmacro VPD_KEY_HAS_VALUES $VPD_HKLM_UNINSTALL_KEY_HAS_VALUES HKLM ${UNINSTALL_REGISTRY_KEY} ${suffix}_hmu
    !insertmacro VPD_READ_NONEMPTY $VPD_HKCU_UNINSTALLSTRING HKCU ${UNINSTALL_REGISTRY_KEY} UninstallString ${suffix}_hku
    !insertmacro VPD_READ_NONEMPTY $VPD_HKLM_UNINSTALLSTRING HKLM ${UNINSTALL_REGISTRY_KEY} UninstallString ${suffix}_hmu
  !macroend

  !macro VPD_CAPTURE_MODE suffix
    StrCpy $VPD_MODE "unknown"
    StrCmp $installMode "CurrentUser" vpd_mode_user_${suffix}
    StrCmp $installMode "all" vpd_mode_all_${suffix}
    Goto vpd_mode_done_${suffix}
    vpd_mode_user_${suffix}:
      StrCpy $VPD_MODE "CurrentUser"
      Goto vpd_mode_done_${suffix}
    vpd_mode_all_${suffix}:
      StrCpy $VPD_MODE "all"
    vpd_mode_done_${suffix}:
  !macroend

  !macro VPD_CAPTURE_INITIAL_LOCATION suffix
    StrCpy $VPD_SELECTED_LOCATION ""
    StrCmp $VPD_MODE "CurrentUser" vpd_select_hkcu_${suffix}
    StrCmp $VPD_MODE "all" vpd_select_hklm_${suffix}
    Goto vpd_select_done_${suffix}
    vpd_select_hkcu_${suffix}:
      ClearErrors
      ReadRegStr $VPD_SELECTED_LOCATION HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ClearErrors
      Goto vpd_select_done_${suffix}
    vpd_select_hklm_${suffix}:
      ClearErrors
      ReadRegStr $VPD_SELECTED_LOCATION HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ClearErrors
    vpd_select_done_${suffix}:
  !macroend

  ; GetFullPathName performs lexical path normalization; no paths leave memory.
  !macro VPD_NORMALIZE_AND_COMPARE suffix
    StrCpy $VPD_INSTDIR_MATCH "false"
    StrCpy $VPD_SELECTED_NORMALIZED ""
    StrCmp $VPD_SELECTED_LOCATION "" vpd_path_done_${suffix}
    ClearErrors
    GetFullPathName $R0 "$VPD_SELECTED_LOCATION"
    IfErrors vpd_path_done_${suffix}
    StrLen $R1 $R0
    ${If} $R1 > 3
      IntOp $R1 $R1 - 1
      StrCpy $R2 $R0 1 $R1
      StrCmp $R2 "\" vpd_trim_registry_${suffix}
      Goto vpd_registry_normalized_${suffix}
      vpd_trim_registry_${suffix}:
        StrCpy $R0 $R0 $R1
      vpd_registry_normalized_${suffix}:
    ${EndIf}
    StrCpy $VPD_SELECTED_NORMALIZED $R0
    GetFullPathName $R0 "$INSTDIR"
    IfErrors vpd_path_done_${suffix}
    StrLen $R1 $R0
    ${If} $R1 > 3
      IntOp $R1 $R1 - 1
      StrCpy $R2 $R0 1 $R1
      StrCmp $R2 "\" vpd_trim_inst_${suffix}
      Goto vpd_inst_normalized_${suffix}
      vpd_trim_inst_${suffix}:
        StrCpy $R0 $R0 $R1
      vpd_inst_normalized_${suffix}:
    ${EndIf}
    StrCmp $R0 "$VPD_SELECTED_NORMALIZED" vpd_path_match_${suffix}
    Goto vpd_path_done_${suffix}
    vpd_path_match_${suffix}:
      StrCpy $VPD_INSTDIR_MATCH "true"
    vpd_path_done_${suffix}:
      ClearErrors
  !macroend

  !macro VPD_CAPTURE_FILES suffix
    StrCpy $VPD_APP_EXE_EXISTS "false"
    StrCpy $VPD_UNINSTALLER_EXISTS "false"
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" vpd_app_exists_${suffix} vpd_app_missing_${suffix}
    vpd_app_exists_${suffix}:
      StrCpy $VPD_APP_EXE_EXISTS "true"
      Goto vpd_app_done_${suffix}
    vpd_app_missing_${suffix}:
      StrCpy $VPD_APP_EXE_EXISTS "false"
    vpd_app_done_${suffix}:
    IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" vpd_uninstaller_exists_${suffix} vpd_uninstaller_missing_${suffix}
    vpd_uninstaller_exists_${suffix}:
      StrCpy $VPD_UNINSTALLER_EXISTS "true"
      Goto vpd_uninstaller_done_${suffix}
    vpd_uninstaller_missing_${suffix}:
      StrCpy $VPD_UNINSTALLER_EXISTS "false"
    vpd_uninstaller_done_${suffix}:
  !macroend

  !macro VPD_BUILD_LINE phase
    StrCpy $VPD_LINE "phase=${phase};mode=$VPD_MODE;instDirMatchesInitRegistry=$VPD_INSTDIR_MATCH;argCurrentUser=$VPD_ARG_CURRENTUSER;argAllUsers=$VPD_ARG_ALLUSERS;argDMarker=$VPD_ARG_D_MARKER;argUninstallerPathMarker=$VPD_ARG_UNINSTALLER_PATH_MARKER;hkcuInstallKeyHasValues=$VPD_HKCU_INSTALL_KEY_HAS_VALUES;hkcuInstallLocationNonempty=$VPD_HKCU_INSTALLLOCATION;hklmInstallKeyHasValues=$VPD_HKLM_INSTALL_KEY_HAS_VALUES;hklmInstallLocationNonempty=$VPD_HKLM_INSTALLLOCATION;hkcuUninstallKeyHasValues=$VPD_HKCU_UNINSTALL_KEY_HAS_VALUES;hkcuUninstallStringNonempty=$VPD_HKCU_UNINSTALLSTRING;hklmUninstallKeyHasValues=$VPD_HKLM_UNINSTALL_KEY_HAS_VALUES;hklmUninstallStringNonempty=$VPD_HKLM_UNINSTALLSTRING;appExeExists=$VPD_APP_EXE_EXISTS;uninstallerExists=$VPD_UNINSTALLER_EXISTS$\r$\n"
  !macroend

  !macro VPD_WRITE_LINE suffix
    StrCmp $VPD_LOG_ENABLED "true" 0 vpd_write_done_${suffix}
    IntOp $0 $VPD_LOG_HANDLE + 0
    StrLen $1 $VPD_LINE
    ; The line is ASCII-only; m converts it to ANSI and byte length equals StrLen.
    System::Call 'kernel32::WriteFile(p r0, m "$VPD_LINE", i r1, *i .r2, p 0) i.r3'
    StrCmp $3 "1" 0 vpd_write_failed_${suffix}
    StrCmp $2 "$1" 0 vpd_write_failed_${suffix}
    System::Call 'kernel32::FlushFileBuffers(p r0) i.r3'
    StrCmp $3 "1" 0 vpd_write_failed_${suffix}
    Goto vpd_write_done_${suffix}
    vpd_write_failed_${suffix}:
      StrCpy $VPD_LOG_ENABLED "false"
    vpd_write_done_${suffix}:
  !macroend

  !macro VPD_CLOSE_LOG suffix
    StrCmp $VPD_LOG_HANDLE "-1" vpd_close_done_${suffix}
    IntOp $0 $VPD_LOG_HANDLE + 0
    System::Call 'kernel32::CloseHandle(p r0) i.r1'
    StrCpy $VPD_LOG_HANDLE "-1"
    StrCpy $VPD_LOG_ENABLED "false"
    vpd_close_done_${suffix}:
  !macroend

  !macro VPD_INIT_PHASE
    !insertmacro VPD_BEGIN init
    !insertmacro VPD_INIT_LOG init
    !insertmacro VPD_CAPTURE_MODE init
    !insertmacro VPD_CAPTURE_FLAGS init
    !insertmacro VPD_CAPTURE_INITIAL_LOCATION init
    !insertmacro VPD_CAPTURE_REGISTRY init
    !insertmacro VPD_NORMALIZE_AND_COMPARE init
    !insertmacro VPD_CAPTURE_FILES init
    !insertmacro VPD_BUILD_LINE init
    !insertmacro VPD_WRITE_LINE init
    !insertmacro VPD_END init
  !macroend

  !macro VPD_SECTION_START_PHASE
    !insertmacro VPD_BEGIN section_start
    !insertmacro VPD_CAPTURE_MODE section_start
    !insertmacro VPD_CAPTURE_REGISTRY section_start
    !insertmacro VPD_NORMALIZE_AND_COMPARE section_start
    !insertmacro VPD_CAPTURE_FILES section_start
    !insertmacro VPD_BUILD_LINE section-start
    !insertmacro VPD_WRITE_LINE section_start
    !insertmacro VPD_END section_start
  !macroend

  !macro VPD_SUCCESS_PHASE
    !insertmacro VPD_BEGIN success
    !insertmacro VPD_CAPTURE_MODE success
    !insertmacro VPD_CAPTURE_REGISTRY success
    !insertmacro VPD_NORMALIZE_AND_COMPARE success
    !insertmacro VPD_CAPTURE_FILES success
    !insertmacro VPD_BUILD_LINE after-success
    !insertmacro VPD_WRITE_LINE success
    !insertmacro VPD_CLOSE_LOG success
    !insertmacro VPD_END success
  !macroend

  !macro VPUC_BEFORE_INIT_CHECK
    !insertmacro VPD_INIT_PHASE
  !macroend

  !macro customUnInstall
    !insertmacro VPD_SECTION_START_PHASE
  !macroend

  ; The production include owns the single success callback in both builds.
  !macro VPUC_AFTER_SUCCESS_CHECK
    !insertmacro VPD_SUCCESS_PHASE
  !macroend
!endif
