@echo off
if "%KEYATLAS_TEST_FAIL_STAGE%"=="secret-scan" (
    echo .\synthetic-secret-candidate.txt
    exit /b 0
)
exit /b 1
