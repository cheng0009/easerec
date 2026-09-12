//! Error types for DirectorCam

use std::fmt;

#[derive(Debug)]
pub enum AppError {
    Capture(String),
    Encode(String),
    Compositor(String),
    Overlay(String),
    Audio(String),
    Recorder(String),
    Io(std::io::Error),
    Win32(String),
    Other(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Capture(msg) => write!(f, "Capture error: {}", msg),
            Self::Encode(msg) => write!(f, "Encode error: {}", msg),
            Self::Compositor(msg) => write!(f, "Compositor error: {}", msg),
            Self::Overlay(msg) => write!(f, "Overlay error: {}", msg),
            Self::Audio(msg) => write!(f, "Audio error: {}", msg),
            Self::Recorder(msg) => write!(f, "Recorder error: {}", msg),
            Self::Io(e) => write!(f, "IO error: {}", e),
            Self::Win32(msg) => write!(f, "Win32 error: {}", msg),
            Self::Other(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

#[cfg(target_os = "windows")]
impl From<windows::core::Error> for AppError {
    fn from(e: windows::core::Error) -> Self {
        Self::Win32(format!("{}", e))
    }
}

pub type AppResult<T> = Result<T, AppError>;
