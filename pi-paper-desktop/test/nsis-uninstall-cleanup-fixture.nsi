; Minimal silent fixture for the production NSIS ownership and cleanup macros.
; It has no uninstall section and never calls WriteUninstaller.

!ifndef VPUC_TEST_TOKEN
  !error "VPUC_TEST_TOKEN must be a unique GUID without braces."
!endif
!ifndef VPUC_TEST_OUTFILE
  !define VPUC_TEST_OUTFILE "VibePaper-NSIS-cleanup-fixture.exe"
!endif

!define INSTALL_REGISTRY_KEY "Software\VibePaperAcceptance\${VPUC_TEST_TOKEN}\Install"
!define UNINSTALL_REGISTRY_KEY "Software\VibePaperAcceptance\${VPUC_TEST_TOKEN}\Uninstall"
!define APP_EXECUTABLE_FILENAME "Pi-Paper.exe"
!define UNINSTALL_FILENAME "Uninstall Pi-Paper.exe"
!define APP_64
; Compile the same macros as the packaged uninstaller, without creating an
; uninstall section or writing/running an uninstaller executable in this fixture.
!define BUILD_UNINSTALLER

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "..\assets\uninstall-cleanup.nsh"

Name "VibePaper NSIS cleanup macro fixture"
OutFile "${VPUC_TEST_OUTFILE}"
RequestExecutionLevel user
SilentInstall silent

Var installMode
Var FixtureExpectedErrors

Function .onInit
  SetSilent silent
  ; Match the view selected by the packaged x64 electron-builder uninstaller.
  SetRegView 64
  StrCpy $INSTDIR "$TEMP\VibePaper Uninstall Cleanup Fixture\${VPUC_TEST_TOKEN}\Pi-Paper"

  ${GetParameters} $R0
  ${GetOptions} $R0 "/mode=" $R1
  IfErrors vpuc_fixture_default_mode
  StrCpy $installMode $R1
  Goto vpuc_fixture_run
  vpuc_fixture_default_mode:
    ClearErrors
    StrCpy $installMode "CurrentUser"
  vpuc_fixture_run:
    StrCpy $VPUC_IS_UPDATED "false"
    StrCmp $installMode "verify-update" 0 +2
      StrCpy $VPUC_IS_UPDATED "true"
    StrCmp $installMode "verify-initial-update" 0 +2
      StrCpy $VPUC_IS_UPDATED "true"
    StrCmp $installMode "verify-initial" vpuc_fixture_initial_target
    StrCmp $installMode "verify-initial-update" vpuc_fixture_initial_target vpuc_fixture_final_target
    vpuc_fixture_initial_target:
      !insertmacro VPUC_VERIFY_INITIAL_TARGET fixture
      SetErrorLevel 0
      Quit
    vpuc_fixture_final_target:
    StrCmp $installMode "verify-files" vpuc_fixture_verify_files
    StrCmp $installMode "verify-update" vpuc_fixture_verify_files vpuc_fixture_registry_cases
    vpuc_fixture_verify_files:
      !insertmacro VPUC_VERIFY_FILES_REMOVED fixture
      SetErrorLevel 0
      Quit
    vpuc_fixture_registry_cases:
    StrCpy $FixtureExpectedErrors "false"
    StrCmp $installMode "CurrentUser-errorflag" 0 +3
      StrCpy $installMode "CurrentUser"
      StrCpy $FixtureExpectedErrors "true"
    StrCpy $0 "fixture-0"
    StrCpy $1 "fixture-1"
    StrCpy $2 "fixture-2"
    StrCpy $R3 "fixture-R3"
    ClearErrors
    StrCmp $FixtureExpectedErrors "true" 0 +2
      SetErrors
    !insertmacro VPUC_CLEANUP_REGISTRATION_KEYS fixture
    IfErrors vpuc_fixture_errors_set vpuc_fixture_errors_clear
    vpuc_fixture_errors_set:
      StrCmp $FixtureExpectedErrors "true" vpuc_fixture_check_registers vpuc_fixture_state_failure
    vpuc_fixture_errors_clear:
      StrCmp $FixtureExpectedErrors "false" vpuc_fixture_check_registers vpuc_fixture_state_failure
    vpuc_fixture_check_registers:
      StrCmp $0 "fixture-0" 0 vpuc_fixture_state_failure
      StrCmp $1 "fixture-1" 0 vpuc_fixture_state_failure
      StrCmp $2 "fixture-2" 0 vpuc_fixture_state_failure
      StrCmp $R3 "fixture-R3" 0 vpuc_fixture_state_failure
    ; Fixture-only diagnostics contain booleans/statuses, never registry values.
    FileOpen $R2 "$EXEDIR\fixture-state.txt" w
    FileWrite $R2 "mode=$installMode;pathMatch=$VPUC_PATH_MATCH;keyState=$VPUC_KEY_STATE;"
    StrCmp $VPUC_UNINSTALL_STRING $VPUC_EXPECTED_UNINSTALL 0 +3
      FileWrite $R2 "commandMatch=true;"
      Goto +2
      FileWrite $R2 "commandMatch=false;"
    StrCmp $VPUC_DISPLAY_ICON "$INSTDIR\${APP_EXECUTABLE_FILENAME},0" 0 +3
      FileWrite $R2 "iconMatch=true"
      Goto +2
      FileWrite $R2 "iconMatch=false"
    FileClose $R2
    SetErrorLevel 0
    Quit
    vpuc_fixture_state_failure:
      SetErrorLevel 3
      Quit
FunctionEnd

Section "Fixture entry point"
SectionEnd
