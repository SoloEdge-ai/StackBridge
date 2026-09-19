param(
  [Parameter(Mandatory = $true)]
  [long]$WindowHandle
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class StackBridgeTestKeyboard
{
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr windowHandle);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindowAsync(IntPtr windowHandle, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PostMessage(IntPtr windowHandle, uint message, UIntPtr wordParameter, IntPtr longParameter);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
"@

$target = [IntPtr]::new($WindowHandle)
if ([StackBridgeTestKeyboard]::GetForegroundWindow() -ne $target) {
  [void][StackBridgeTestKeyboard]::ShowWindowAsync($target, 9)
  [void][StackBridgeTestKeyboard]::SetForegroundWindow($target)
  Start-Sleep -Milliseconds 200
}
if ([StackBridgeTestKeyboard]::GetForegroundWindow() -eq $target) {
  [StackBridgeTestKeyboard]::keybd_event(0x77, 0, 0, [UIntPtr]::Zero)
  [StackBridgeTestKeyboard]::keybd_event(0x77, 0, 2, [UIntPtr]::Zero)
  exit 0
}

if (-not [StackBridgeTestKeyboard]::PostMessage($target, 0x0100, [UIntPtr]::new([uint64]0x77), [IntPtr]::Zero)) {
  throw "F8 keydown could not be posted to the launched StackBridge window"
}
[void][StackBridgeTestKeyboard]::PostMessage($target, 0x0101, [UIntPtr]::new([uint64]0x77), [IntPtr]::Zero)
