with open('mod.rs', 'r', encoding='utf-8') as f:
    content = f.read()

is_active_method = '''
    /// Check if an effect is currently active
    pub fn is_effect_active(&self, effect: &str) -> bool {
        match effect {
            "magnifier" => self.magnifier.lock().map(|m| m.active).unwrap_or(false),
            "step_marker" => self.step_marker.lock().map(|m| m.active).unwrap_or(false),
            "highlighter" => self.highlighter.lock().map(|m| m.active).unwrap_or(false),
            "ripple" => self.ripple.lock().map(|r| r.active).unwrap_or(false),
            _ => false,
        }
    }
'''

content = content.replace(
    '    pub fn toggle_effect(&mut self, effect: &str, active: bool) {',
    is_active_method + '\n    pub fn toggle_effect(&mut self, effect: &str, active: bool) {'
)

with open('mod.rs', 'w', encoding='utf-8') as f:
    f.write(content)
print('is_effect_active added')
