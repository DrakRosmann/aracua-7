//! Quadros binários do mapa LiDAR (ver docs/protocolo.md).

pub const AVX1: &[u8; 4] = b"AVX1";
pub const AOB1: &[u8; 4] = b"AOB1";
pub const AVX1_HEADER: usize = 36;
pub const AVX1_POINT: usize = 8;
pub const AOB1_HEADER: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Voxel {
    pub e: i16,
    pub n: i16,
    pub u: i16,
    pub class: u8,
    pub intensity: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Voxels {
        reset: bool,
        origin_lat: f64,
        origin_lon: f64,
        origin_alt: f32,
        voxel_m: f32,
        voxels: Vec<Voxel>,
    },
    Sectors {
        increment_deg: f32,
        max_range_m: f32,
        distances_cm: Vec<u16>,
    },
}

pub fn encode_voxels(
    reset: bool,
    origin: (f64, f64, f32),
    voxel_m: f32,
    voxels: &[Voxel],
) -> Vec<u8> {
    let mut b = Vec::with_capacity(AVX1_HEADER + voxels.len() * AVX1_POINT);
    b.extend_from_slice(AVX1);
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&(reset as u16).to_le_bytes());
    b.extend_from_slice(&origin.0.to_le_bytes());
    b.extend_from_slice(&origin.1.to_le_bytes());
    b.extend_from_slice(&origin.2.to_le_bytes());
    b.extend_from_slice(&voxel_m.to_le_bytes());
    b.extend_from_slice(&(voxels.len() as u32).to_le_bytes());
    for v in voxels {
        b.extend_from_slice(&v.e.to_le_bytes());
        b.extend_from_slice(&v.n.to_le_bytes());
        b.extend_from_slice(&v.u.to_le_bytes());
        b.push(v.class);
        b.push(v.intensity);
    }
    b
}

pub fn encode_sectors(increment_deg: f32, max_range_m: f32, distances_cm: &[u16]) -> Vec<u8> {
    let mut b = Vec::with_capacity(AOB1_HEADER + distances_cm.len() * 2);
    b.extend_from_slice(AOB1);
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&(distances_cm.len() as u16).to_le_bytes());
    b.extend_from_slice(&increment_deg.to_le_bytes());
    b.extend_from_slice(&max_range_m.to_le_bytes());
    for d in distances_cm {
        b.extend_from_slice(&d.to_le_bytes());
    }
    b
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn i16_at(b: &[u8], o: usize) -> i16 {
    i16::from_le_bytes([b[o], b[o + 1]])
}
fn f32_at(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn f64_at(b: &[u8], o: usize) -> f64 {
    f64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

/// Valida e decodifica um quadro. Retorna `None` se estiver malformado.
pub fn decode(b: &[u8]) -> Option<Frame> {
    if b.len() < 8 {
        return None;
    }
    match &b[0..4] {
        m if m == AVX1 => {
            if b.len() < AVX1_HEADER || u16_at(b, 4) != 1 {
                return None;
            }
            let n = u32::from_le_bytes(b[32..36].try_into().ok()?) as usize;
            if b.len() != AVX1_HEADER + n * AVX1_POINT {
                return None;
            }
            let voxels = (0..n)
                .map(|i| {
                    let o = AVX1_HEADER + i * AVX1_POINT;
                    Voxel {
                        e: i16_at(b, o),
                        n: i16_at(b, o + 2),
                        u: i16_at(b, o + 4),
                        class: b[o + 6],
                        intensity: b[o + 7],
                    }
                })
                .collect();
            Some(Frame::Voxels {
                reset: u16_at(b, 6) & 1 == 1,
                origin_lat: f64_at(b, 8),
                origin_lon: f64_at(b, 16),
                origin_alt: f32_at(b, 24),
                voxel_m: f32_at(b, 28),
                voxels,
            })
        }
        m if m == AOB1 => {
            if b.len() < AOB1_HEADER || u16_at(b, 4) != 1 {
                return None;
            }
            let n = u16_at(b, 6) as usize;
            if b.len() != AOB1_HEADER + n * 2 {
                return None;
            }
            Some(Frame::Sectors {
                increment_deg: f32_at(b, 8),
                max_range_m: f32_at(b, 12),
                distances_cm: (0..n).map(|i| u16_at(b, AOB1_HEADER + i * 2)).collect(),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn voxels_round_trip() {
        let v = vec![
            Voxel { e: -3, n: 7, u: 12, class: 1, intensity: 200 },
            Voxel { e: 100, n: -250, u: 0, class: 0, intensity: 9 },
        ];
        let b = encode_voxels(true, (-23.5, -46.6, 760.0), 1.0, &v);
        assert_eq!(b.len(), AVX1_HEADER + 2 * AVX1_POINT);
        match decode(&b).unwrap() {
            Frame::Voxels { reset, voxels, origin_lat, voxel_m, .. } => {
                assert!(reset);
                assert_eq!(voxels, v);
                assert_eq!(origin_lat, -23.5);
                assert_eq!(voxel_m, 1.0);
            }
            _ => panic!(),
        }
    }
    #[test]
    fn sectors_round_trip() {
        let d: Vec<u16> = (0..72).map(|i| if i == 3 { 1234 } else { 0xFFFF }).collect();
        let b = encode_sectors(5.0, 90.0, &d);
        assert_eq!(decode(&b), Some(Frame::Sectors { increment_deg: 5.0, max_range_m: 90.0, distances_cm: d }));
    }
    /// Quadros de referência em docs/fixtures, os mesmos que o C++ de bordo e a interface conferem.
    #[test]
    fn matches_shared_fixtures() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/fixtures");
        let avx = std::fs::read(dir.join("avx1_exemplo.bin")).unwrap();
        let v = vec![
            Voxel { e: -3, n: 7, u: 12, class: 1, intensity: 200 },
            Voxel { e: 100, n: -250, u: 0, class: 0, intensity: 9 },
            Voxel { e: 32767, n: -32768, u: -1, class: 1, intensity: 255 },
        ];
        assert_eq!(encode_voxels(true, (-23.55052, -46.63331, 760.0), 0.5, &v), avx);
        assert!(matches!(decode(&avx), Some(Frame::Voxels { reset: true, voxels, .. }) if voxels == v));

        let aob = std::fs::read(dir.join("aob1_exemplo.bin")).unwrap();
        let mut d = vec![0xFFFFu16; 72];
        d[0] = 150;
        d[18] = 420;
        d[71] = 4001;
        assert_eq!(encode_sectors(5.0, 40.0, &d), aob);
        assert_eq!(decode(&aob), Some(Frame::Sectors { increment_deg: 5.0, max_range_m: 40.0, distances_cm: d }));
    }
    #[test]
    fn rejects_garbage() {
        assert!(decode(b"AVX1\x01\x00").is_none());
        assert!(decode(b"XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX").is_none());
        let mut b = encode_sectors(5.0, 90.0, &[1, 2, 3]);
        b.pop();
        assert!(decode(&b).is_none());
    }
}
