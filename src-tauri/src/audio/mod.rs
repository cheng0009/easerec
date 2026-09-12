//! WASAPI audio capture: system loopback + microphone
//! Uses Windows Audio Session API for dual-stream mixing.

pub mod crossfade;

use std::sync::{Arc, Mutex};
use std::ptr;
use windows::Win32::Media::Audio::{
    IMMDeviceEnumerator, MMDeviceEnumerator,
    eRender, eConsole, eCapture,
    AUDCLNT_SHAREMODE_SHARED,
    IAudioClient, IAudioCaptureClient,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CLSCTX_ALL,
    CoInitializeEx, CoUninitialize,
    COINIT_MULTITHREADED, CoTaskMemFree,
};
use crate::config::AudioSource;

pub struct AudioCapture {
    shared_buffer: Arc<Mutex<Vec<f32>>>,
    running: Arc<std::sync::atomic::AtomicBool>,
    pub source: AudioSource,
}

impl AudioCapture {
    pub fn new(source: AudioSource) -> Self {
        Self {
            shared_buffer: Arc::new(Mutex::new(Vec::new())),
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            source,
        }
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.running.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        self.running.store(true, std::sync::atomic::Ordering::SeqCst);
        log::info!("WASAPI: initializing audio capture (source: {:?})...", self.source);

        let buffer = self.shared_buffer.clone();
        let running = self.running.clone();
        let source = self.source;

        std::thread::spawn(move || {
            unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }

            if let Err(e) = unsafe { Self::capture_loop(&buffer, &running, source) } {
                log::error!("WASAPI capture error: {}", e);
            }

            unsafe { CoUninitialize(); }
            log::info!("WASAPI: capture thread exited");
        });

        Ok(())
    }

    unsafe fn capture_loop(
        buffer: &Arc<Mutex<Vec<f32>>>,
        running: &Arc<std::sync::atomic::AtomicBool>,
        source: AudioSource,
    ) -> Result<(), String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("CoCreate MMDeviceEnumerator: {:?}", e))?;

        let loopback = if source == AudioSource::System || source == AudioSource::Both {
            Self::open_loopback(&enumerator)
        } else { None };
        let mic = if source == AudioSource::Mic || source == AudioSource::Both {
            Self::open_mic(&enumerator)
        } else { None };

        if loopback.is_none() && mic.is_none() {
            return Err("No audio devices available".into());
        }
        log::info!("WASAPI: capture active (loopback={}, mic={})",
            loopback.is_some(), mic.is_some());

        let mut mix_buf: Vec<f32> = Vec::with_capacity(4096);

        loop {
            if !running.load(std::sync::atomic::Ordering::SeqCst) { break; }
            std::thread::sleep(std::time::Duration::from_millis(5));
            mix_buf.clear();

            if let Some(ref cap) = loopback {
                Self::read_client(cap, &mut mix_buf);
            }
            if let Some(ref cap) = mic {
                Self::read_client(cap, &mut mix_buf);
            }

            if !mix_buf.is_empty() {
                if let Ok(mut buf) = buffer.lock() {
                    buf.extend_from_slice(&mix_buf);
                    let max = 44100 * 10;
                    let blen = buf.len(); if blen > max { buf.drain(0..blen - max); }
                }
            }
        }
        Ok(())
    }

    unsafe fn open_loopback(enumerator: &IMMDeviceEnumerator) -> Option<IAudioCaptureClient> {
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        log::info!("WASAPI: loopback device found");
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None).ok()?;
        let mix_fmt = client.GetMixFormat().ok()?;
        let _ = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED, 0x00000020, 30_000_000, 0, &*mix_fmt, None,
        ).ok()?;
        CoTaskMemFree(Some(mix_fmt as _));
        let capture: IAudioCaptureClient = client.GetService().ok()?;
        let _ = client.Start();
        log::info!("WASAPI: loopback started");
        Some(capture)
    }

    unsafe fn open_mic(enumerator: &IMMDeviceEnumerator) -> Option<IAudioCaptureClient> {
        let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?;
        log::info!("WASAPI: mic device found");
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None).ok()?;
        let mix_fmt = client.GetMixFormat().ok()?;
        let _ = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED, 0, 30_000_000, 0, &*mix_fmt, None,
        ).ok()?;
        CoTaskMemFree(Some(mix_fmt as _));
        let capture: IAudioCaptureClient = client.GetService().ok()?;
        let _ = client.Start();
        log::info!("WASAPI: mic started");
        Some(capture)
    }

    unsafe fn read_client(capture: &IAudioCaptureClient, buffer: &mut Vec<f32>) {
        let mut data_ptr: *mut u8 = ptr::null_mut();
        let mut frames: u32 = 0;
        let mut flags: u32 = 0;
        let mut dev_pos: u64 = 0;
        let mut qpc_pos: u64 = 0;

        loop {
            match capture.GetBuffer(&mut data_ptr, &mut frames, &mut flags, Some(&mut dev_pos), Some(&mut qpc_pos)) {
                Ok(()) => {
                    if frames == 0 { break; }
                    let samples = std::slice::from_raw_parts(data_ptr as *const f32, (frames as usize) * 2);
                    for chunk in samples.chunks(2) {
                        let s = if chunk.len() >= 2 { (chunk[0] + chunk[1]) * 0.5 } else { chunk[0] };
                        buffer.push(s.max(-1.0).min(1.0));
                    }
                    let _ = capture.ReleaseBuffer(frames);
                }
                Err(e) => {
                    if e.code().0 as u32 == 0x88890008 { break; }
                    break;
                }
            }
        }
    }

    pub fn stop(&mut self) {
        self.running.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn read_samples(&mut self) -> Result<Vec<f32>, String> {
        if let Ok(mut buf) = self.shared_buffer.lock() {
            if buf.is_empty() { return Ok(vec![]); }
            Ok(std::mem::take(&mut *buf))
        } else {
            Ok(vec![])
        }
    }
}
