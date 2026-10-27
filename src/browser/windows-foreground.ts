/**
 * Ensure visible Chrome/Chromium windows actually appear on top on Windows.
 *
 * When an MCP server is spawned by an IDE/Electron host on Windows with
 * `CREATE_NO_WINDOW` / `windowsHide: true`, Windows passes `STARTF_USESHOWWINDOW`
 * + `SW_HIDE` in `STARTUPINFO`. Chromium inherits that show-state on its initial
 * window (`Chrome_WidgetWin_1`), leaving the login window hidden from both the
 * screen and the taskbar!
 *
 * This helper combines:
 *   1. Playwright `page.bringToFront()`
 *   2. Chrome DevTools Protocol `Browser.setWindowBounds` (`windowState: "normal"`)
 *   3. Win32 `EnumWindows` + `ShowWindow(SW_SHOW)` + `SetWindowPos` foreground raise
 *      targeting the exact `chrome.exe` process tree for `profileDir`.
 */

import { execFile } from "node:child_process";
import type { Page } from "patchright";
import { log } from "../utils/logger.js";

interface CdpWindowResult {
  windowId: number;
}

export async function ensureBrowserWindowVisible(page: Page, profileDir: string): Promise<void> {
  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  // 1. Un-minimize / normalize window state via Chrome DevTools Protocol
  try {
    const cdp = await page.context().newCDPSession(page);
    try {
      const targetWin = (await cdp.send("Browser.getWindowForTarget")) as CdpWindowResult;
      if (typeof targetWin?.windowId === "number") {
        await cdp
          .send("Browser.setWindowBounds", {
            windowId: targetWin.windowId,
            bounds: { windowState: "normal" },
          })
          .catch(() => undefined);
        await cdp
          .send("Browser.setWindowBounds", {
            windowId: targetWin.windowId,
            bounds: { left: 90, top: 60, width: 1360, height: 880 },
          })
          .catch(() => undefined);
      }
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } catch {
    /* CDP window bounds unsupported in headless or non-Chromium */
  }

  if (process.platform !== "win32") {
    return;
  }

  // 2. Win32 EnumWindows unhide + foreground raise for windows owned by this profile's Chrome
  const escapedProfile = profileDir.replace(/'/g, "''");
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$targetProfile = '${escapedProfile}'
$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'chromium.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($targetProfile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }
$pids = @($procs | ForEach-Object { [uint32]$_.ProcessId })
if ($pids.Count -eq 0) { Write-Output "NO_PIDS"; exit 0 }

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class WinUnhide {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$pidSet = [System.Collections.Generic.HashSet[uint32]]::new([uint32[]]$pids)
$shown = 0
$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOMOVE = 0x0002
$SWP_NOSIZE = 0x0001
$SWP_SHOWWINDOW = 0x0040

[WinUnhide]::EnumWindows({
  param($hWnd, $lParam)
  $winPid = [uint32]0
  [void][WinUnhide]::GetWindowThreadProcessId($hWnd, [ref]$winPid)
  if ($pidSet.Contains($winPid)) {
    $cls = [System.Text.StringBuilder]::new(128)
    [void][WinUnhide]::GetClassName($hWnd, $cls, $cls.Capacity)
    if ($cls.ToString() -eq 'Chrome_WidgetWin_1') {
      $rect = New-Object WinUnhide+RECT
      [void][WinUnhide]::GetWindowRect($hWnd, [ref]$rect)
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      $title = [System.Text.StringBuilder]::new(256)
      [void][WinUnhide]::GetWindowText($hWnd, $title, $title.Capacity)
      if ($w -gt 200 -and $h -gt 200) {
        [void][WinUnhide]::ShowWindow($hWnd, 9)
        [void][WinUnhide]::ShowWindow($hWnd, 5)
        [void][WinUnhide]::SetWindowPos($hWnd, $HWND_TOPMOST, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW))
        [void][WinUnhide]::SetWindowPos($hWnd, $HWND_NOTOPMOST, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW))
        [void][WinUnhide]::SetForegroundWindow($hWnd)
        $vis = [WinUnhide]::IsWindowVisible($hWnd)
        Write-Output ("SHOWN hwnd=" + $hWnd + " vis=" + $vis + " size=" + $w + "x" + $h + " title=" + $title.ToString())
        $script:shown++
      }
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
Write-Output ("TOTAL_SHOWN=" + $shown)
`;

  await new Promise<void>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      { timeout: 8_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          log.dim(`  🪟 Windows foreground helper skipped: ${err.message}`);
        } else if (stdout) {
          const summary = stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .join(" | ");
          log.info(`  🪟 Windows window state: ${summary}`);
        }
        resolve();
      }
    );
  });
}
