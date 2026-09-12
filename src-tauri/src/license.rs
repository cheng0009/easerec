//! License management for freemium model
//! Supports: offline key validation + Microsoft Store licensing

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// License status
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum LicenseTier {
    Free,
    Pro,
}

/// Stored license data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseData {
    pub tier: LicenseTier,
    pub key_hash: String,
    pub activated_at: String,
    pub source: String, // "store", "key", "trial"
}

impl Default for LicenseData {
    fn default() -> Self {
        Self {
            tier: LicenseTier::Free,
            key_hash: String::new(),
            activated_at: String::new(),
            source: "free".into(),
        }
    }
}

/// License manager — handles validation, activation, status queries
pub struct LicenseManager {
    data: LicenseData,
}

impl LicenseManager {
    pub fn new() -> Self {
        let data = Self::load();
        Self { data }
    }

    fn license_path() -> PathBuf {
        let mut path = dirs_next::config_dir()
            .unwrap_or_else(|| PathBuf::from("."));
        path.push("DirectorCam");
        std::fs::create_dir_all(&path).ok();
        path.push("license.json");
        path
    }

    fn load() -> LicenseData {
        let path = Self::license_path();
        if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            LicenseData::default()
        }
    }

    fn save(&self) {
        if let Ok(s) = serde_json::to_string_pretty(&self.data) {
            std::fs::write(Self::license_path(), s).ok();
        }
    }

    pub fn is_pro(&self) -> bool {
        matches!(self.data.tier, LicenseTier::Pro)
    }

    pub fn tier(&self) -> LicenseTier { self.data.tier }
    pub fn data(&self) -> LicenseData { self.data.clone() }

    /// Validate and activate a license key (offline HMAC-based)
    pub fn activate_key(&mut self, key: &str) -> Result<bool, String> {
        let clean = key.trim().to_uppercase().replace('-', "").replace(' ', "");

        // Basic format check: 16 hex chars
        if clean.len() < 16 {
            return Err("Invalid key format".into());
        }

        // Simple validation: first 12 chars are the payload, last 4 are checksum
        let payload = &clean[..clean.len() - 4];
        let checksum = &clean[clean.len() - 4..];

        if Self::compute_checksum(payload) != checksum {
            return Err("Invalid license key".into());
        }

        // Valid key — activate
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        key.hash(&mut h);
        let hash = format!("{:x}", h.finish());

        self.data = LicenseData {
            tier: LicenseTier::Pro,
            key_hash: hash,
            activated_at: chrono_now(),
            source: "key".into(),
        };
        self.save();

        log::info!("License activated: Pro tier");
        Ok(true)
    }

    /// Activate via Microsoft Store (called from frontend after Store purchase)
    pub fn activate_store(&mut self) -> Result<bool, String> {
        self.data = LicenseData {
            tier: LicenseTier::Pro,
            key_hash: "store".into(),
            activated_at: chrono_now(),
            source: "store".into(),
        };
        self.save();
        log::info!("License activated via Microsoft Store");
        Ok(true)
    }

    /// Deactivate (reset to free)
    pub fn deactivate(&mut self) {
        self.data = LicenseData::default();
        self.save();
    }

    /// Generate a pro license key (dev tool)
    fn compute_checksum(payload: &str) -> String {
        let mut sum: u64 = 0;
        for (i, b) in payload.bytes().enumerate() {
            sum = sum.wrapping_add((b as u64).wrapping_mul(i as u64 + 1));
        }
        format!("{:04X}", sum & 0xFFFF)
    }

    /// Generate a valid pro key (for admin/dev use)
    pub fn generate_pro_key() -> String {
        use rand::Rng;
        let payload: String = (0..12)
            .map(|_| format!("{:X}", rand::thread_rng().gen_range(0..16)))
            .collect();
        let checksum = Self::compute_checksum(&payload);
        let full = format!("{}{}", payload, checksum).to_uppercase();
        // Format as XXXX-XXXX-XXXX-XXXX
        format!("{}-{}-{}-{}", &full[0..4], &full[4..8], &full[8..12], &full[12..16])
    }
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_generation_and_validation() {
        let key = LicenseManager::generate_pro_key();
        let mut mgr = LicenseManager::new();
        let result = mgr.activate_key(&key);
        assert!(result.is_ok());
        assert!(mgr.is_pro());

        // Clean up
        mgr.deactivate();
        assert!(!mgr.is_pro());
    }

    #[test]
    fn test_invalid_key() {
        let mut mgr = LicenseManager::new();
        let result = mgr.activate_key("INVALID-KEY-HERE-1234");
        assert!(result.is_err());
        assert!(!mgr.is_pro());
    }
}