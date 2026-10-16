//! Conexão MAVLink compartilhada e envio de mensagens.

use aracua_bridge::{apm::*, GCS_COMPONENT_ID, GCS_SYSTEM_ID};
use mavlink::{MavConnection, MavHeader};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

pub struct Link {
    conn: mavlink::Connection<MavMessage>,
    seq: Mutex<u8>,
    target_system: AtomicU8,
    target_component: AtomicU8,
}

impl Link {
    pub fn new(conn: mavlink::Connection<MavMessage>) -> Self {
        let mut conn = conn;
        conn.set_protocol_version(mavlink::MavlinkVersion::V2);
        Self { conn, seq: Mutex::new(0), target_system: AtomicU8::new(1), target_component: AtomicU8::new(1) }
    }

    pub fn recv(&self) -> Result<(MavHeader, MavMessage), mavlink::error::MessageReadError> {
        self.conn.recv()
    }

    pub fn set_target(&self, sys: u8, comp: u8) {
        self.target_system.store(sys, Ordering::Relaxed);
        self.target_component.store(comp, Ordering::Relaxed);
    }

    pub fn target(&self) -> (u8, u8) {
        (self.target_system.load(Ordering::Relaxed), self.target_component.load(Ordering::Relaxed))
    }

    pub fn send(&self, msg: &MavMessage) {
        let sequence = {
            let mut s = self.seq.lock().unwrap();
            *s = s.wrapping_add(1);
            *s
        };
        let header = MavHeader { system_id: GCS_SYSTEM_ID, component_id: GCS_COMPONENT_ID, sequence };
        if let Err(e) = self.conn.send(&header, msg) {
            tracing::debug!("falha ao enviar {:?}: {e}", std::mem::discriminant(msg));
        }
    }

    pub fn command_long(&self, command: MavCmd, p: [f32; 7]) {
        let (ts, tc) = self.target();
        self.send(&MavMessage::COMMAND_LONG(COMMAND_LONG_DATA {
            param1: p[0],
            param2: p[1],
            param3: p[2],
            param4: p[3],
            param5: p[4],
            param6: p[5],
            param7: p[6],
            command,
            target_system: ts,
            target_component: tc,
            confirmation: 0,
        }));
    }

    pub fn heartbeat(&self) {
        self.send(&MavMessage::HEARTBEAT(HEARTBEAT_DATA {
            custom_mode: 0,
            mavtype: MavType::MAV_TYPE_GCS,
            autopilot: MavAutopilot::MAV_AUTOPILOT_INVALID,
            base_mode: MavModeFlag::empty(),
            system_status: MavState::MAV_STATE_ACTIVE,
            mavlink_version: 3,
        }));
    }

    /// Pede ao ArduPilot que envie todos os fluxos de telemetria a 10 Hz.
    pub fn request_streams(&self) {
        let (ts, tc) = self.target();
        self.send(&MavMessage::REQUEST_DATA_STREAM(REQUEST_DATA_STREAM_DATA {
            req_message_rate: 10,
            target_system: ts,
            target_component: tc,
            req_stream_id: 0, // MAV_DATA_STREAM_ALL
            start_stop: 1,
        }));
        // Mensagens que não fazem parte dos fluxos padrão.
        for (id, hz) in [(242.0, 0.5), (241.0, 2.0), (147.0, 1.0)] {
            // HOME_POSITION, VIBRATION, BATTERY_STATUS
            self.command_long(MavCmd::MAV_CMD_SET_MESSAGE_INTERVAL, [id, 1e6 / hz, 0.0, 0.0, 0.0, 0.0, 0.0]);
        }
    }
}
