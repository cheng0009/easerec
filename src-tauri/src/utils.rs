//! Safe locking utilities

use std::sync::{Mutex, MutexGuard, PoisonError};

pub trait SafeLock<T> {
    fn slock(&self) -> Result<MutexGuard<'_, T>, String>;
}

impl<T> SafeLock<T> for Mutex<T> {
    fn slock(&self) -> Result<MutexGuard<'_, T>, String> {
        self.lock().map_err(|e: PoisonError<_>| {
            let msg = format!("Mutex poisoned: {}", e);
            log::error!("{}", msg);
            self.clear_poison();
            msg
        })
    }
}
