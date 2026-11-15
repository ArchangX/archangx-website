# Saves a Stripe SANDBOX key as the Windows user environment variable STRIPE_API_KEY, without showing it on
# screen and without it ever being typed on a command line (so it never lands in the PowerShell history).
#
#   powershell -ExecutionPolicy Bypass -File scripts\stripe\set-key.ps1           save a sandbox key (rk_test_...)
#   powershell -ExecutionPolicy Bypass -File scripts\stripe\set-key.ps1 -Remove   delete the saved key
#
# Live keys are refused on purpose: for a live run, set the key in that one terminal only and close it after.
# After saving, quit VS Code completely and reopen it so new terminals (and Claude Code) see the variable.
param([switch]$Remove)

$historyFile = $null
try { $historyFile = (Get-PSReadLineOption).HistorySavePath } catch { }
if (-not $historyFile) { $historyFile = Join-Path $env:APPDATA "Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt" }

function Clear-KeyFromHistory {
    # Removes any line that contains something shaped like a Stripe secret or restricted key.
    if (-not (Test-Path $historyFile)) { return }
    $pattern = '(rk|sk)_(test|live)_[A-Za-z0-9]{10,}'
    $lines = Get-Content -LiteralPath $historyFile -Encoding UTF8
    $kept = @($lines | Where-Object { $_ -notmatch $pattern })
    $removed = @($lines).Count - $kept.Count
    if ($removed -gt 0) {
        Set-Content -LiteralPath $historyFile -Value $kept -Encoding UTF8
        Write-Host "Removed $removed line(s) containing a Stripe key from your PowerShell history."
    }
}

if ($Remove) {
    [Environment]::SetEnvironmentVariable("STRIPE_API_KEY", $null, "User")
    Remove-Item Env:STRIPE_API_KEY -ErrorAction SilentlyContinue
    Clear-KeyFromHistory
    Write-Host "STRIPE_API_KEY removed from your user environment."
    exit 0
}

Write-Host "Copy the sandbox key in Stripe (Developers > API keys, the copy icon next to the rk_test_ key)."
$secure = Read-Host "Paste it here and press Enter (it shows as *)" -AsSecureString
$key = [Net.NetworkCredential]::new("", $secure).Password.Trim()

if (-not $key) { Write-Host "Nothing was pasted. Nothing was saved."; exit 1 }
if ($key -match '^(rk|sk)_live_') { Write-Host "That is a LIVE key. This helper only saves sandbox keys. Nothing was saved."; exit 1 }
if ($key -match '^sk_test_') { Write-Host "That is the unrestricted secret key (sk_test_). Use the restricted key (rk_test_) instead. Nothing was saved."; exit 1 }
if ($key -notmatch '^rk_test_[A-Za-z0-9]{20,}$') { Write-Host "That does not look like a Stripe restricted sandbox key (rk_test_...). Nothing was saved."; exit 1 }

[Environment]::SetEnvironmentVariable("STRIPE_API_KEY", $key, "User")
$key = $null; $secure = $null
Clear-KeyFromHistory
Write-Host "Saved a sandbox key (rk_test_...) as STRIPE_API_KEY for your Windows user."
Write-Host "Now quit VS Code completely (every window) and open it again."
