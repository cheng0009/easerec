//! Microsoft Store detection
//! For Store builds, compile with: --features store-build
//! Store builds use Store entitlement; self-distributed use HMAC keys.

/// Check if this is a Microsoft Store build
pub fn is_store_app() -> bool {
    cfg!(feature = "store-build")
}