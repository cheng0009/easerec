// Privacy Shield - detect and obscure sensitive on-screen information

use regex::Regex;

#[derive(Debug, Clone, PartialEq)]
pub enum SensitiveType {
    ApiKey,
    Email,
    Password,
    CreditCard,
    IpAddress,
    Custom(String),
}

#[derive(Debug, Clone)]
pub struct SensitiveRegion {
    pub info_type: SensitiveType,
    pub matched_text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub blur_radius: f32,
}

pub struct PrivacyConfig {
    pub enabled: bool,
    pub detect_types: Vec<SensitiveType>,
    pub blur_radius: f32,
}

impl Default for PrivacyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            detect_types: vec![SensitiveType::ApiKey, SensitiveType::Email, SensitiveType::Password],
            blur_radius: 20.0,
        }
    }
}

pub struct PrivacyShield {
    config: PrivacyConfig,
    patterns: Vec<(SensitiveType, Regex)>,
}

impl PrivacyShield {
    pub fn new(config: PrivacyConfig) -> Self {
        let patterns = Self::build_patterns(&config);
        Self { config, patterns }
    }

    fn build_patterns(config: &PrivacyConfig) -> Vec<(SensitiveType, Regex)> {
        let mut patterns = Vec::new();

        for t in &config.detect_types {
            let pattern_str = match t {
                SensitiveType::ApiKey => {
                    concat!(
                        r"(?i)(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|",
                        r"(?:api[_-]?key|secret|token)\s*[:=]\s*[a-zA-Z0-9_\-\.]{16,})"
                    )
                }
                SensitiveType::Email => {
                    r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
                }
                SensitiveType::Password => {
                    r"(?i)(?:password|passwd|pwd)\s*[:=]\s*\S+"
                }
                SensitiveType::CreditCard => {
                    r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b"
                }
                SensitiveType::IpAddress => {
                    r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"
                }
                SensitiveType::Custom(pattern) => pattern.as_str(),
            };

            if let Ok(re) = Regex::new(pattern_str) {
                patterns.push((t.clone(), re));
            }
        }

        patterns
    }

    pub fn scan_text(&self, text: &str) -> Vec<SensitiveRegion> {
        if !self.config.enabled {
            return vec![];
        }

        let mut regions = Vec::new();

        for (info_type, re) in &self.patterns {
            for m in re.find_iter(text) {
                regions.push(SensitiveRegion {
                    info_type: info_type.clone(),
                    matched_text: m.as_str().to_string(),
                    x: 0.0,
                    y: 0.0,
                    width: 0.3,
                    height: 0.05,
                    blur_radius: self.config.blur_radius,
                });
            }
        }

        if !regions.is_empty() {
            log::info!("Privacy shield: detected {} sensitive regions ", regions.len());
        }

        regions
    }

    pub fn update_config(&mut self, config: PrivacyConfig) {
        self.patterns = Self::build_patterns(&config);
        self.config = config;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_openai_api_key() {
        let config = PrivacyConfig {
            enabled: true,
            detect_types: vec![SensitiveType::ApiKey],
            ..Default::default()
        };
        let shield = PrivacyShield::new(config);
        let text = "export OPENAI_API_KEY= sk-proj-abc123xyz456 ";
        let regions = shield.scan_text(text);
        assert!(!regions.is_empty());
    }

    #[test]
    fn test_detect_email() {
        let config = PrivacyConfig {
            enabled: true,
            detect_types: vec![SensitiveType::Email],
            ..Default::default()
        };
        let shield = PrivacyShield::new(config);
        let text = "Contact us at admin@example.com for help ";
        let regions = shield.scan_text(text);
        assert!(!regions.is_empty());
    }

    #[test]
    fn test_disabled_shield() {
        let config = PrivacyConfig { enabled: false, ..Default::default() };
        let shield = PrivacyShield::new(config);
        let regions = shield.scan_text("sk-abc123def456 ");
        assert!(regions.is_empty());
    }

    #[test]
    fn test_no_sensitive_info() {
        let config = PrivacyConfig {
            enabled: true,
            detect_types: vec![SensitiveType::ApiKey, SensitiveType::Email],
            ..Default::default()
        };
        let shield = PrivacyShield::new(config);
        let text = "This is just a normal sentence without any secrets. ";
        let regions = shield.scan_text(text);
        assert!(regions.is_empty());
    }
}
