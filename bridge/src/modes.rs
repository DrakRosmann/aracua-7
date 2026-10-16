//! Classe do veículo e modos de voo do ArduPilot (campo `custom_mode` do HEARTBEAT).
//!
//! Cada firmware numera os modos do seu jeito: o mesmo número 5 é LOITER no
//! ArduCopter e FBWA no ArduPlane. A classe vem do `mavtype` do HEARTBEAT.

use crate::apm::MavType;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum VehicleClass {
    /// Multirrotor (ArduCopter).
    #[default]
    Copter,
    /// Helicóptero convencional (ArduCopter TradHeli): mesmos modos do multirrotor.
    Heli,
    /// Asa fixa (ArduPlane).
    Plane,
    /// Asa fixa com rotores de pairar (ArduPlane QuadPlane): modos do avião mais os modos Q.
    Vtol,
    /// Carro ou barco (ArduRover).
    Rover,
}

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

pub const PLANE_MODES: &[(&str, u32)] = &[
    ("MANUAL", 0),
    ("CIRCLE", 1),
    ("STABILIZE", 2),
    ("TRAINING", 3),
    ("ACRO", 4),
    ("FBWA", 5),
    ("FBWB", 6),
    ("CRUISE", 7),
    ("AUTOTUNE", 8),
    ("AUTO", 10),
    ("RTL", 11),
    ("LOITER", 12),
    ("TAKEOFF", 13),
    ("AVOID_ADSB", 14),
    ("GUIDED", 15),
    ("QSTABILIZE", 17),
    ("QHOVER", 18),
    ("QLOITER", 19),
    ("QLAND", 20),
    ("QRTL", 21),
    ("QAUTOTUNE", 22),
    ("QACRO", 23),
    ("THERMAL", 24),
    ("LOITER_ALT_QLAND", 25),
    ("AUTOLAND", 26),
];

pub const ROVER_MODES: &[(&str, u32)] = &[
    ("MANUAL", 0),
    ("ACRO", 1),
    ("STEERING", 3),
    ("HOLD", 4),
    ("LOITER", 5),
    ("FOLLOW", 6),
    ("SIMPLE", 7),
    ("DOCK", 8),
    ("CIRCLE", 9),
    ("AUTO", 10),
    ("RTL", 11),
    ("SMART_RTL", 12),
    ("GUIDED", 15),
];

impl VehicleClass {
    /// Classe a partir do `mavtype` do HEARTBEAT. Tipos desconhecidos ficam como multirrotor.
    pub fn from_mav_type(t: MavType) -> Self {
        let name = format!("{t:?}");
        match t {
            MavType::MAV_TYPE_HELICOPTER => VehicleClass::Heli,
            MavType::MAV_TYPE_FIXED_WING => VehicleClass::Plane,
            MavType::MAV_TYPE_GROUND_ROVER | MavType::MAV_TYPE_SURFACE_BOAT => VehicleClass::Rover,
            _ if name.contains("VTOL") => VehicleClass::Vtol,
            _ => VehicleClass::Copter,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            VehicleClass::Copter => "copter",
            VehicleClass::Heli => "heli",
            VehicleClass::Plane => "plane",
            VehicleClass::Vtol => "vtol",
            VehicleClass::Rover => "rover",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        [VehicleClass::Copter, VehicleClass::Heli, VehicleClass::Plane, VehicleClass::Vtol, VehicleClass::Rover]
            .into_iter()
            .find(|c| c.as_str() == s.to_ascii_lowercase())
    }

    /// `mavtype` que este tipo de veículo anuncia (usado pelo simulador).
    pub fn mav_type(self) -> MavType {
        match self {
            VehicleClass::Copter => MavType::MAV_TYPE_QUADROTOR,
            VehicleClass::Heli => MavType::MAV_TYPE_HELICOPTER,
            VehicleClass::Plane => MavType::MAV_TYPE_FIXED_WING,
            VehicleClass::Vtol => MavType::MAV_TYPE_VTOL_FIXEDROTOR,
            VehicleClass::Rover => MavType::MAV_TYPE_GROUND_ROVER,
        }
    }

    pub fn modes(self) -> &'static [(&'static str, u32)] {
        match self {
            VehicleClass::Copter | VehicleClass::Heli => COPTER_MODES,
            VehicleClass::Plane | VehicleClass::Vtol => PLANE_MODES,
            VehicleClass::Rover => ROVER_MODES,
        }
    }

    /// Asa fixa: não paira, decola pelo modo TAKEOFF.
    pub fn fixed_wing(self) -> bool {
        matches!(self, VehicleClass::Plane | VehicleClass::Vtol)
    }
}

pub fn mode_name(class: VehicleClass, custom_mode: u32) -> String {
    class
        .modes()
        .iter()
        .find(|(_, n)| *n == custom_mode)
        .map(|(s, _)| s.to_string())
        .unwrap_or_else(|| format!("MODE_{custom_mode}"))
}

pub fn mode_number(class: VehicleClass, name: &str) -> Option<u32> {
    let up = name.to_ascii_uppercase();
    class.modes().iter().find(|(s, _)| *s == up).map(|(_, n)| *n)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip() {
        for class in [VehicleClass::Copter, VehicleClass::Plane, VehicleClass::Rover] {
            for (name, n) in class.modes() {
                assert_eq!(mode_number(class, name), Some(*n));
                assert_eq!(mode_name(class, *n), *name);
            }
        }
        assert_eq!(mode_number(VehicleClass::Copter, "loiter"), Some(5));
        assert_eq!(mode_number(VehicleClass::Copter, "nada"), None);
    }
    #[test]
    fn mesmo_numero_modo_diferente() {
        assert_eq!(mode_name(VehicleClass::Copter, 5), "LOITER");
        assert_eq!(mode_name(VehicleClass::Plane, 5), "FBWA");
        assert_eq!(mode_name(VehicleClass::Heli, 9), "LAND");
        assert_eq!(mode_number(VehicleClass::Vtol, "QHOVER"), Some(18));
        assert_eq!(mode_number(VehicleClass::Copter, "QHOVER"), None);
        assert_eq!(mode_number(VehicleClass::Plane, "TAKEOFF"), Some(13));
    }
    #[test]
    fn classe_pelo_heartbeat() {
        assert_eq!(VehicleClass::from_mav_type(MavType::MAV_TYPE_QUADROTOR), VehicleClass::Copter);
        assert_eq!(VehicleClass::from_mav_type(MavType::MAV_TYPE_HEXAROTOR), VehicleClass::Copter);
        assert_eq!(VehicleClass::from_mav_type(MavType::MAV_TYPE_HELICOPTER), VehicleClass::Heli);
        assert_eq!(VehicleClass::from_mav_type(MavType::MAV_TYPE_FIXED_WING), VehicleClass::Plane);
        assert_eq!(VehicleClass::from_mav_type(MavType::MAV_TYPE_VTOL_TILTROTOR), VehicleClass::Vtol);
        assert_eq!(VehicleClass::from_mav_type(MavType::MAV_TYPE_VTOL_TAILSITTER_QUADROTOR), VehicleClass::Vtol);
        assert_eq!(VehicleClass::from_mav_type(MavType::MAV_TYPE_SURFACE_BOAT), VehicleClass::Rover);
        for c in [VehicleClass::Copter, VehicleClass::Heli, VehicleClass::Plane, VehicleClass::Vtol, VehicleClass::Rover] {
            assert_eq!(VehicleClass::from_mav_type(c.mav_type()), c);
            assert_eq!(VehicleClass::parse(c.as_str()), Some(c));
        }
    }
}
