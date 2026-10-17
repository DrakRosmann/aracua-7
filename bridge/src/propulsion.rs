//! Motor e energia: baterias (com células), ESCs, injeção eletrônica/turbina (EFI),
//! gerador e valores extras de sensores, para o painel do motor da interface.
//!
//! O ArduPilot manda `BATTERY_STATUS` por bateria, `ESC_TELEMETRY_x_TO_y` com até
//! 32 ESCs, `EFI_STATUS` da injeção (pistão ou turbina via script), `GENERATOR_STATUS`
//! dos geradores (RichenPower, Loweheiser, célula de combustível) e `RPM` dos sensores
//! de rotação. Sensores sem mensagem própria (temperatura da água, óleo, estado da
//! turbina) chegam por `NAMED_VALUE_FLOAT`/`NAMED_VALUE_INT` de scripts Lua.

use aracua_bridge::apm::*;
use aracua_bridge::char_array_to_string;
use serde::Serialize;
use std::collections::BTreeMap;

/// Sem mensagem nova depois disso, o ESC ou a bateria sai da lista.
const DROP_AFTER_MS: u64 = 10_000;
/// EFI, gerador e valores nomeados ficam mais tempo (a interface avisa que pararam)
/// antes de sumir: um motor que parou de falar em voo não deve sumir da tela na hora.
const FORGET_AFTER_MS: u64 = 60_000;
/// Limite de valores nomeados guardados (scripts com nomes variáveis não enchem a memória).
const MAX_NAMED: usize = 64;

#[derive(Serialize, Clone, Default)]
pub struct Pack {
    pub id: u8,
    /// all, propulsion, avionics, payload ou unknown.
    pub function: String,
    pub voltage: f32,
    /// A; positiva descarregando, negativa carregando.
    pub current: Option<f32>,
    pub consumed_mah: Option<i32>,
    pub energy_wh: Option<f32>,
    pub remaining: Option<i8>,
    pub temperature: Option<f32>,
    /// Tensão de cada célula (V); vazia quando a bateria só informa o total.
    pub cells: Vec<f32>,
    pub time_remaining_s: Option<i32>,
    pub charge_state: String,
    pub faults: Vec<String>,
    pub age_ms: u64,
    #[serde(skip)]
    at_ms: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct Esc {
    /// Número do ESC/motor, a partir de 1.
    pub n: u8,
    pub rpm: u32,
    pub temperature: f32,
    pub voltage: f32,
    pub current: f32,
    pub consumed_mah: u32,
    pub age_ms: u64,
    #[serde(skip)]
    at_ms: u64,
}

/// `EFI_STATUS`: injeção de motor a pistão ou ECU de turbina. NaN vira `null` no JSON.
#[derive(Serialize, Clone, Default)]
pub struct Efi {
    pub healthy: bool,
    pub ecu_index: f32,
    pub rpm: f32,
    /// cm³ desde que a ECU ligou.
    pub fuel_consumed: f32,
    /// cm³/min.
    pub fuel_flow: f32,
    pub engine_load: f32,
    pub throttle: f32,
    pub cht: f32,
    pub egt: f32,
    pub intake_pressure: f32,
    pub intake_temperature: f32,
    pub barometric_pressure: f32,
    pub ignition_voltage: f32,
    pub fuel_pressure: f32,
    pub age_ms: u64,
    #[serde(skip)]
    at_ms: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct Generator {
    /// Bits de `MAV_GENERATOR_STATUS_FLAG` ligados, em minúsculas sem o prefixo (ex.: `generating`).
    pub status: Vec<String>,
    pub rpm: Option<u16>,
    /// A; positiva saindo da bateria, negativa carregando.
    pub battery_current: Option<f32>,
    pub load_current: Option<f32>,
    pub power_w: Option<f32>,
    pub bus_voltage: f32,
    pub rectifier_temperature: Option<i16>,
    pub generator_temperature: Option<i16>,
    pub runtime_s: Option<u32>,
    pub maintenance_s: Option<i32>,
    pub age_ms: u64,
    #[serde(skip)]
    at_ms: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct Propulsion {
    pub batteries: Vec<Pack>,
    pub escs: Vec<Esc>,
    pub efi: Option<Efi>,
    pub generator: Option<Generator>,
    /// Sensores de rotação 1 e 2 (mensagem `RPM`); `null` sem leitura.
    pub rpm: [Option<f32>; 2],
    /// `NAMED_VALUE_FLOAT`/`INT` mais recentes (ex.: `H2O`, `CHT2`, `OILP`, `FUEL`, `TURB_ST`).
    pub named: BTreeMap<String, f32>,
    #[serde(skip)]
    named_at: BTreeMap<String, u64>,
    #[serde(skip)]
    rpm_at: u64,
}

fn opt_f(v: f32) -> Option<f32> {
    v.is_finite().then_some(v)
}

fn flag_names<'a, T>(bits: impl Iterator<Item = (&'a str, T)>, prefix: &str) -> Vec<String> {
    bits.map(|(name, _)| name.replace(prefix, "").to_lowercase()).collect()
}

/// Células de `BATTERY_STATUS`. Sem leitura por célula, o padrão manda o total na
/// primeira posição (dividido em pedaços de 65534 mV se passar disso).
pub fn cells_of(voltages: &[u16; 10], ext: &[u16; 4]) -> (f32, Vec<f32>) {
    let main: Vec<u16> = voltages.iter().copied().take_while(|&v| v != u16::MAX).collect();
    if main.is_empty() {
        return (0.0, vec![]);
    }
    let total_only = main.len() == 1 || main[0] == u16::MAX - 1 || main.iter().any(|&v| v > 5000);
    if total_only {
        return (main.iter().map(|&v| v as f32 / 1000.0).sum(), vec![]);
    }
    let mut cells: Vec<f32> = main.iter().map(|&v| v as f32 / 1000.0).collect();
    if cells.len() == 10 {
        cells.extend(ext.iter().take_while(|&&v| v != 0 && v != u16::MAX).map(|&v| v as f32 / 1000.0));
    }
    (cells.iter().sum(), cells)
}

impl Propulsion {
    /// Atualiza com uma mensagem; retorna se ela era de motor/energia.
    pub fn update(&mut self, msg: &MavMessage, now: u64) -> bool {
        use MavMessage::*;
        match msg {
            BATTERY_STATUS(b) => {
                let (voltage, cells) = cells_of(&b.voltages, &b.voltages_ext);
                let pack = Pack {
                    id: b.id,
                    function: format!("{:?}", b.battery_function).replace("MAV_BATTERY_FUNCTION_", "").replace("TYPE_", "").to_lowercase(),
                    voltage,
                    current: (b.current_battery != -1).then_some(b.current_battery as f32 / 100.0),
                    consumed_mah: (b.current_consumed >= 0).then_some(b.current_consumed),
                    energy_wh: (b.energy_consumed >= 0).then_some(b.energy_consumed as f32 / 36.0),
                    remaining: (b.battery_remaining >= 0).then_some(b.battery_remaining),
                    temperature: (b.temperature != i16::MAX).then_some(b.temperature as f32 / 100.0),
                    cells,
                    time_remaining_s: (b.time_remaining > 0).then_some(b.time_remaining),
                    charge_state: format!("{:?}", b.charge_state).replace("MAV_BATTERY_CHARGE_STATE_", "").to_lowercase(),
                    faults: flag_names(b.fault_bitmask.iter_names(), "MAV_BATTERY_FAULT_"),
                    age_ms: 0,
                    at_ms: now,
                };
                match self.batteries.iter_mut().find(|p| p.id == b.id) {
                    Some(p) => *p = pack,
                    None => {
                        self.batteries.push(pack);
                        self.batteries.sort_by_key(|p| p.id);
                    }
                }
            }
            ESC_TELEMETRY_1_TO_4(e) => self.escs4(0, &e.temperature, &e.voltage, &e.current, &e.totalcurrent, &e.rpm, &e.count, now),
            ESC_TELEMETRY_5_TO_8(e) => self.escs4(4, &e.temperature, &e.voltage, &e.current, &e.totalcurrent, &e.rpm, &e.count, now),
            ESC_TELEMETRY_9_TO_12(e) => self.escs4(8, &e.temperature, &e.voltage, &e.current, &e.totalcurrent, &e.rpm, &e.count, now),
            ESC_TELEMETRY_13_TO_16(e) => self.escs4(12, &e.temperature, &e.voltage, &e.current, &e.totalcurrent, &e.rpm, &e.count, now),
            EFI_STATUS(e) => {
                self.efi = Some(Efi {
                    healthy: e.health == 1,
                    ecu_index: e.ecu_index,
                    rpm: e.rpm,
                    fuel_consumed: e.fuel_consumed,
                    fuel_flow: e.fuel_flow,
                    engine_load: e.engine_load,
                    throttle: e.throttle_position,
                    cht: e.cylinder_head_temperature,
                    egt: e.exhaust_gas_temperature,
                    intake_pressure: e.intake_manifold_pressure,
                    intake_temperature: e.intake_manifold_temperature,
                    barometric_pressure: e.barometric_pressure,
                    ignition_voltage: e.ignition_voltage,
                    fuel_pressure: e.fuel_pressure,
                    age_ms: 0,
                    at_ms: now,
                })
            }
            GENERATOR_STATUS(g) => {
                self.generator = Some(Generator {
                    status: flag_names(g.status.iter_names(), "MAV_GENERATOR_STATUS_FLAG_"),
                    rpm: (g.generator_speed != u16::MAX).then_some(g.generator_speed),
                    battery_current: opt_f(g.battery_current),
                    load_current: opt_f(g.load_current),
                    power_w: opt_f(g.power_generated),
                    bus_voltage: g.bus_voltage,
                    rectifier_temperature: (g.rectifier_temperature != i16::MAX).then_some(g.rectifier_temperature),
                    generator_temperature: (g.generator_temperature != i16::MAX).then_some(g.generator_temperature),
                    runtime_s: (g.runtime != u32::MAX).then_some(g.runtime),
                    maintenance_s: (g.time_until_maintenance != i32::MAX).then_some(g.time_until_maintenance),
                    age_ms: 0,
                    at_ms: now,
                })
            }
            RPM(r) => {
                // O ArduPilot manda -1 para sensor sem leitura.
                self.rpm = [r.rpm1, r.rpm2].map(|v| (v >= 0.0 && v.is_finite()).then_some(v));
                self.rpm_at = now;
            }
            NAMED_VALUE_FLOAT(n) => self.named(char_array_to_string(&n.name), n.value, now),
            NAMED_VALUE_INT(n) => self.named(char_array_to_string(&n.name), n.value as f32, now),
            _ => return false,
        }
        true
    }

    fn named(&mut self, name: String, value: f32, now: u64) {
        if self.named.len() < MAX_NAMED || self.named.contains_key(&name) {
            self.named_at.insert(name.clone(), now);
            self.named.insert(name, value);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn escs4(&mut self, first: u8, temp: &[u8; 4], volt: &[u16; 4], cur: &[u16; 4], total: &[u16; 4], rpm: &[u16; 4], count: &[u16; 4], now: u64) {
        for i in 0..4 {
            // Posições sem ESC vêm zeradas.
            if count[i] == 0 && volt[i] == 0 && rpm[i] == 0 && temp[i] == 0 && cur[i] == 0 {
                continue;
            }
            let esc = Esc {
                n: first + i as u8 + 1,
                rpm: rpm[i] as u32,
                temperature: temp[i] as f32,
                voltage: volt[i] as f32 / 100.0,
                current: cur[i] as f32 / 100.0,
                consumed_mah: total[i] as u32,
                age_ms: 0,
                at_ms: now,
            };
            match self.escs.iter_mut().find(|e| e.n == esc.n) {
                Some(e) => *e = esc,
                None => {
                    self.escs.push(esc);
                    self.escs.sort_by_key(|e| e.n);
                }
            }
        }
    }

    /// Idade de cada leitura; ESCs e baterias que pararam de falar saem da lista.
    pub fn refresh(&mut self, now: u64) {
        let age = |at: u64| now.saturating_sub(at);
        self.escs.retain(|e| age(e.at_ms) < DROP_AFTER_MS);
        self.batteries.retain(|b| age(b.at_ms) < DROP_AFTER_MS);
        if self.efi.as_ref().is_some_and(|e| age(e.at_ms) >= FORGET_AFTER_MS) {
            self.efi = None;
        }
        if self.generator.as_ref().is_some_and(|g| age(g.at_ms) >= FORGET_AFTER_MS) {
            self.generator = None;
        }
        if age(self.rpm_at) >= FORGET_AFTER_MS {
            self.rpm = [None, None];
        }
        let old: Vec<String> = self.named_at.iter().filter(|(_, at)| age(**at) >= FORGET_AFTER_MS).map(|(k, _)| k.clone()).collect();
        for k in old {
            self.named.remove(&k);
            self.named_at.remove(&k);
        }
        for e in &mut self.escs {
            e.age_ms = age(e.at_ms);
        }
        for b in &mut self.batteries {
            b.age_ms = age(b.at_ms);
        }
        if let Some(e) = &mut self.efi {
            e.age_ms = age(e.at_ms);
        }
        if let Some(g) = &mut self.generator {
            g.age_ms = age(g.at_ms);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn celulas_e_total() {
        let mut v = [u16::MAX; 10];
        v[..3].copy_from_slice(&[4100, 4050, 4120]);
        let (total, cells) = cells_of(&v, &[0; 4]);
        assert_eq!(cells.len(), 3);
        assert!((total - 12.27).abs() < 1e-3);
        // Só o total, na primeira posição.
        let mut v = [u16::MAX; 10];
        v[0] = 22_800;
        assert_eq!(cells_of(&v, &[0; 4]), (22.8, vec![]));
        // Total acima de 65,5 V: dividido em pedaços.
        let mut v = [u16::MAX; 10];
        v[0] = u16::MAX - 1;
        v[1] = 34_466;
        let (total, cells) = cells_of(&v, &[0; 4]);
        assert!(cells.is_empty() && (total - 100.0).abs() < 1e-3);
        // 12 células: as duas últimas em voltages_ext.
        let (total, cells) = cells_of(&[3900; 10], &[3910, 3920, 0, 0]);
        assert_eq!(cells.len(), 12);
        assert!((total - 46.83).abs() < 1e-3);
        assert_eq!(cells_of(&[u16::MAX; 10], &[0; 4]), (0.0, vec![]));
    }

    #[test]
    fn escs_bateria_efi_gerador_e_valores() {
        let mut p = Propulsion::default();
        assert!(p.update(&MavMessage::ESC_TELEMETRY_1_TO_4(ESC_TELEMETRY_1_TO_4_DATA {
            temperature: [40, 42, 0, 0], voltage: [2480, 2470, 0, 0], current: [1250, 1310, 0, 0],
            totalcurrent: [300, 310, 0, 0], rpm: [7100, 7180, 0, 0], count: [9, 9, 0, 0],
        }), 1000));
        p.update(&MavMessage::ESC_TELEMETRY_5_TO_8(ESC_TELEMETRY_5_TO_8_DATA { rpm: [6900, 0, 0, 0], count: [3, 0, 0, 0], ..Default::default() }), 1000);
        assert_eq!(p.escs.iter().map(|e| e.n).collect::<Vec<_>>(), vec![1, 2, 5]);
        assert_eq!(p.escs[1].rpm, 7180);
        assert!((p.escs[0].current - 12.5).abs() < 1e-3 && (p.escs[0].voltage - 24.8).abs() < 1e-3);

        let mut v = [u16::MAX; 10];
        v[..2].copy_from_slice(&[3800, 3810]);
        p.update(&MavMessage::BATTERY_STATUS(BATTERY_STATUS_DATA {
            id: 1, voltages: v, current_battery: -350, current_consumed: 120, energy_consumed: 3600,
            battery_remaining: 64, temperature: 3150, battery_function: MavBatteryFunction::MAV_BATTERY_FUNCTION_PROPULSION,
            ..Default::default()
        }), 1000);
        let b = &p.batteries[0];
        assert_eq!((b.id, b.function.as_str(), b.remaining, b.cells.len()), (1, "propulsion", Some(64), 2));
        assert_eq!((b.current, b.energy_wh, b.temperature), (Some(-3.5), Some(100.0), Some(31.5)));

        p.update(&MavMessage::EFI_STATUS(EFI_STATUS_DATA { health: 1, rpm: 5400.0, cylinder_head_temperature: 182.0, exhaust_gas_temperature: f32::NAN, ..Default::default() }), 1000);
        let j = serde_json::to_value(p.efi.as_ref().unwrap()).unwrap();
        assert_eq!((j["rpm"].as_f64(), j["cht"].as_f64(), j["healthy"].as_bool()), (Some(5400.0), Some(182.0), Some(true)));
        assert!(j["egt"].is_null(), "NaN vira null");

        p.update(&MavMessage::GENERATOR_STATUS(GENERATOR_STATUS_DATA {
            status: MavGeneratorStatusFlag::MAV_GENERATOR_STATUS_FLAG_GENERATING | MavGeneratorStatusFlag::MAV_GENERATOR_STATUS_FLAG_CHARGING,
            generator_speed: u16::MAX, battery_current: -4.0, load_current: f32::NAN, power_generated: 900.0, bus_voltage: 50.2,
            rectifier_temperature: 55, generator_temperature: i16::MAX, runtime: 3600, time_until_maintenance: i32::MAX, bat_current_setpoint: 0.0,
        }), 1000);
        let g = p.generator.as_ref().unwrap();
        assert_eq!(g.status, vec!["generating", "charging"]);
        assert_eq!((g.rpm, g.load_current, g.generator_temperature, g.rectifier_temperature), (None, None, None, Some(55)));

        p.update(&MavMessage::RPM(RPM_DATA { rpm1: 6100.0, rpm2: -1.0 }), 1000);
        assert_eq!(p.rpm, [Some(6100.0), None]);
        p.update(&MavMessage::NAMED_VALUE_FLOAT(NAMED_VALUE_FLOAT_DATA { name: "H2O".into(), value: 88.0, time_boot_ms: 0 }), 1000);
        assert_eq!(p.named.get("H2O"), Some(&88.0));
        assert!(!p.update(&MavMessage::HEARTBEAT(Default::default()), 1000));

        // ESC que parou de falar sai; EFI fica, com a idade.
        p.update(&MavMessage::ESC_TELEMETRY_1_TO_4(ESC_TELEMETRY_1_TO_4_DATA { rpm: [7000, 7000, 0, 0], count: [1, 1, 0, 0], ..Default::default() }), 9000);
        p.refresh(12_000);
        assert_eq!(p.escs.iter().map(|e| e.n).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(p.escs[0].age_ms, 3000);
        assert_eq!(p.efi.as_ref().unwrap().age_ms, 11_000);
        assert!(p.batteries.is_empty());
        // Um minuto sem notícias: EFI, gerador, RPM e valores nomeados somem.
        p.refresh(61_000);
        assert!(p.efi.is_none() && p.generator.is_none() && p.named.is_empty() && p.rpm == [None, None]);
    }
}
