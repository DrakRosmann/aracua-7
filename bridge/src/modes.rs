//! Modos de voo do ArduCopter (campo `custom_mode` do HEARTBEAT).

pub const COPTER_MODES: &[(&str, u32)] = &[
    ("STABILIZE", 0),
    ("ACRO", 1),
    ("ALT_HOLD", 2),
    ("AUTO", 3),
    ("GUIDED", 4),
    ("LOITER", 5),
    ("RTL", 6),
    ("CIRCLE", 7),
    ("LAND", 9),
    ("DRIFT", 11),
    ("SPORT", 13),
    ("FLIP", 14),
    ("AUTOTUNE", 15),
    ("POSHOLD", 16),
    ("BRAKE", 17),
    ("THROW", 18),
    ("SMART_RTL", 21),
];

pub fn mode_name(custom_mode: u32) -> String {
    COPTER_MODES
        .iter()
        .find(|(_, n)| *n == custom_mode)
        .map(|(s, _)| s.to_string())
        .unwrap_or_else(|| format!("MODE_{custom_mode}"))
}

pub fn mode_number(name: &str) -> Option<u32> {
    let up = name.to_ascii_uppercase();
    COPTER_MODES.iter().find(|(s, _)| *s == up).map(|(_, n)| *n)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip() {
        for (name, n) in COPTER_MODES {
            assert_eq!(mode_number(name), Some(*n));
            assert_eq!(mode_name(*n), *name);
        }
        assert_eq!(mode_number("loiter"), Some(5));
        assert_eq!(mode_number("nada"), None);
    }
}
