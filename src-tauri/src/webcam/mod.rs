//! Webcam capture module using nokhwa (MSMF backend on Windows)
//! Captures frames from the default webcam and converts to BGRA for compositing.

use std::sync::{Arc, Mutex};
use nokhwa::{
    nokhwa_initialize,
    Camera,
    utils::{CameraIndex, RequestedFormat, RequestedFormatType, CameraFormat, Resolution, FrameFormat, ApiBackend},
    pixel_format::RgbFormat,
};

pub struct WebcamCapture {
    camera: Option<Camera>,
    last_frame: Arc<Mutex<Option<(Vec<u8>, u32, u32)>>>, // BGRA data, width, height
    running: Arc<std::sync::atomic::AtomicBool>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl WebcamCapture {
    pub fn new() -> Self {
        Self {
            camera: None,
            last_frame: Arc::new(Mutex::new(None)),
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            width: 0,
            height: 0,
            fps: 30,
        }
    }

    pub fn list_cameras() -> Vec<(usize, String)> {
        nokhwa_initialize(|granted| {
            log::info!("Camera permission: {}", granted);
        });
        let cameras = nokhwa::query(ApiBackend::Auto).unwrap_or_default();
        cameras
            .into_iter()
            .enumerate()
            .map(|(i, info)| (i, info.human_name()))
            .collect()
    }

    pub fn start(&mut self, camera_index: u32, _target_width: u32, _target_height: u32) -> Result<(), String> {
        if self.running.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }

        nokhwa_initialize(|granted| {
            log::info!("Webcam: camera permission granted={}", granted);
        });

        let cameras = nokhwa::query(ApiBackend::Auto)
            .map_err(|e| format!("Failed to query cameras: {}", e))?;

        if cameras.is_empty() {
            return Err("No cameras found".into());
        }

        let ci = camera_index as usize;
        if ci >= cameras.len() {
            return Err(format!("Camera index {} out of range (max {})", ci, cameras.len()));
        }
        let camera_info = &cameras[ci];
        log::info!("Webcam: opening camera '{}'", camera_info.human_name());

        let requested = RequestedFormat::new::<RgbFormat>(
            RequestedFormatType::Closest(CameraFormat::new(
                Resolution::new(640, 480),
                FrameFormat::MJPEG,
                30,
            ))
        );

        // Probe camera (just for format info, don't open stream)
        {
            let probe_idx = CameraIndex::Index(camera_index);
            let probe = Camera::new(probe_idx, requested.clone())
                .map_err(|e| format!("Failed to open camera: {}", e))?;
            let actual_fmt = probe.camera_format();
            self.width = actual_fmt.width();
            self.height = actual_fmt.height();
            self.fps = actual_fmt.frame_rate();
            log::info!("Webcam: actual format {}x{} @ {} fps",
                self.width, self.height, self.fps);
            // Drop probe so capture thread can open the device exclusively
        }

        self.running.store(true, std::sync::atomic::Ordering::SeqCst);

        // Spawn capture thread (creates its own camera connection)
        let last_frame = self.last_frame.clone();
        let running = self.running.clone();

        std::thread::spawn(move || {
            let thread_idx = CameraIndex::Index(camera_index);
            let mut camera = match Camera::new(thread_idx, requested) {
                Ok(c) => c,
                Err(e) => { log::error!("Webcam thread: failed to create camera: {}", e); return; }
            };
            if let Err(e) = camera.open_stream() {
                log::error!("Webcam thread: failed to open stream: {}", e);
                return;
            }
            log::info!("Webcam: capture loop started");

            loop {
                if !running.load(std::sync::atomic::Ordering::SeqCst) { break; }
                match camera.frame() {
                    Ok(frame) => {
                        let rgb_buf = frame.decode_image::<RgbFormat>().unwrap_or_default();
                        let fw = rgb_buf.width() as usize;
                        let fh = rgb_buf.height() as usize;
                        let mut bgra: Vec<u8> = Vec::with_capacity(fw * fh * 4);
                        for y in 0..fh {
                            for x in 0..fw {
                                let pixel = rgb_buf[(x as u32, y as u32)];
                                bgra.push(pixel[2]);
                                bgra.push(pixel[1]);
                                bgra.push(pixel[0]);
                                bgra.push(255u8);
                            }
                        }
                        if let Ok(mut lf) = last_frame.lock() {
                            *lf = Some((bgra, fw as u32, fh as u32));
                        }
                    }
                    Err(e) => {
                        log::error!("Webcam frame error: {}", e);
                        std::thread::sleep(std::time::Duration::from_millis(33));
                    }
                }
            }
            let _ = camera.stop_stream();
            log::info!("Webcam: capture thread exited");
        });

        log::info!("Webcam: started capture ({}x{} @ {}fps)", self.width, self.height, self.fps);
        Ok(())
    }

    pub fn latest_frame(&self) -> Option<(Vec<u8>, u32, u32)> {
        self.last_frame.lock().ok().and_then(|lf| lf.clone())
    }    /// Get a shared reference to the latest captured frame (for pipeline & overlay)
    pub fn frame_source(&self) -> Arc<Mutex<Option<(Vec<u8>, u32, u32)>>> {
        self.last_frame.clone()
    }


    pub fn stop(&mut self) {
        self.running.store(false, std::sync::atomic::Ordering::SeqCst);
        if let Some(ref mut cam) = self.camera {
            let _ = cam.stop_stream();
        }
        self.camera = None;
        log::info!("Webcam: stopped");
    }

    pub fn is_running(&self) -> bool {
        self.running.load(std::sync::atomic::Ordering::SeqCst)
    }
}

unsafe impl Send for WebcamCapture {}
unsafe impl Sync for WebcamCapture {}


