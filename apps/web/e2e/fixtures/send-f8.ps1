Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class StackBridgeTestKeyboard
{
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
"@

$shell = New-Object -ComObject WScript.Shell
$activated = $shell.AppActivate("StackBridge")
if (-not $activated) {
  throw "StackBridge window could not be activated"
}
Start-Sleep -Milliseconds 200
[StackBridgeTestKeyboard]::keybd_event(0x77, 0, 0, [UIntPtr]::Zero)
[StackBridgeTestKeyboard]::keybd_event(0x77, 0, 2, [UIntPtr]::Zero)
