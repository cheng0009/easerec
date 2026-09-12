//! Focus Mode — clean recording environment
//! Toggle via F1. Hides taskbar, enables Windows Focus Assist (DND).

use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, ShowWindow, SW_HIDE, SW_SHOW};
use windows::core::w;
use crate::error::AppResult;

pub struct StudioManager {
    is_active: bool,
}

impl StudioManager {
    pub fn new() -> Self { Self { is_active: false } }
    pub fn is_active(&self) -> bool { self.is_active }

    pub fn enable(&mut self) -> AppResult<()> {
        if self.is_active { return Ok(()); }
        self.is_active = true;
        hide_taskbar(true);
        set_quiet_hours(true);
        show_toast("🔕 Focus Mode ON", "Taskbar hidden, notifications blocked");
        log::info!("Focus Mode ON");
        Ok(())
    }

    pub fn disable(&mut self) -> AppResult<()> {
        if !self.is_active { return Ok(()); }
        self.is_active = false;
        set_quiet_hours(false);
        hide_taskbar(false);
        show_toast("🔔 Focus Mode OFF", "Taskbar restored");
        log::info!("Focus Mode OFF");
        Ok(())
    }
}

fn hide_taskbar(hide: bool) {
    let cmd = if hide { SW_HIDE } else { SW_SHOW };
    unsafe {
        if let Ok(hwnd) = FindWindowW(w!("Shell_TrayWnd"), None) {
            let _ = ShowWindow(hwnd, cmd);
        }
        if let Ok(hwnd) = FindWindowW(w!("Shell_SecondaryTrayWnd"), None) {
            let _ = ShowWindow(hwnd, cmd);
        }
    }
}

fn set_quiet_hours(enable: bool) {
    let val = if enable { "0" } else { "1" };
    let ps = format!(
        "New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings' -Name 'NOC_GLOBAL_SETTING_TOASTS_ENABLED' -Value {} -PropertyType DWORD -Force",
        val
    );
    let _ = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &ps]).output();
}

fn show_toast(title: &str, message: &str) {
    let ps = format!(
        r#"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;
$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);
$tpl.SelectSingleNode('//text[1]').InnerText = '{}';
$tpl.SelectSingleNode('//text[2]').InnerText = '{}';
$notif = [Windows.UI.Notifications.ToastNotification]::new($tpl);
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DirectorCam').Show($notif);
"#,
        title.replace("'", "''"),
        message.replace("'", "''")
    );
    let _ = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &ps]).output();
}

unsafe impl Send for StudioManager {}
unsafe impl Sync for StudioManager {}