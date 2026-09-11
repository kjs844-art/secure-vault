@echo off
echo VERIFY_TEST_CARGO:%*
echo "VERIFY_TEST_CWD:%CD%"
if "%KEYATLAS_TEST_FAIL_STAGE%"=="feature-test" if "%~1"=="test" if "%~6"=="--features" exit /b 23
if "%KEYATLAS_TEST_FAIL_STAGE%"=="doctest" if "%~1"=="test" if "%~5"=="--doc" exit /b 23
if "%KEYATLAS_TEST_FAIL_STAGE%"=="%~1" exit /b 23
exit /b 0
