//! JavaScript `Math` results for City compilation.
//!
//! Earlier compilers stored distances computed by Node's V8. Platform libm
//! functions differ from V8 in the last bit for a few percent of inputs, so
//! Cities would not be byte-identical. V8 implements these functions with the
//! freely licensed fdlibm 5.3 routines (notice below), compiled by clang with
//! floating-point contraction: within one C expression, `a*b + c` is a single
//! fused multiply-add (the left product when both operands are products). This
//! port fuses at exactly those points, on every platform, so a Rust build is
//! deterministic and matches Node on arm64. `hypot` follows V8's normalized
//! Kahan sum. Node on x86-64 runs without fused operations and can differ in
//! the last bit.
//!
//! Checked against Node 26 on arm64: sin, cos, atan, atan2, asin and hypot
//! were identical on 1.05 million inputs from 1e-9 to 1e5, and haversine
//! distances on 400,000 Boston and DC coordinate pairs.
//!
//! ====================================================
//! Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//!
//! Developed at SunSoft, a Sun Microsystems, Inc. business.
//! Permission to use, copy, modify, and distribute this
//! software is freely granted, provided that this notice
//! is preserved.
//! ====================================================

// fdlibm's constants keep their published decimal digits; each rounds to the
// double the C source uses, including those equal to a std constant.
#![allow(clippy::excessive_precision, clippy::approx_constant)]

const S1: f64 = -1.666_666_666_666_663_243_48e-1;
const S2: f64 = 8.333_333_333_322_489_461_24e-3;
const S3: f64 = -1.984_126_982_985_794_931_34e-4;
const S4: f64 = 2.755_731_370_707_006_767_89e-6;
const S5: f64 = -2.505_076_025_340_686_341_95e-8;
const S6: f64 = 1.589_690_995_211_550_102_21e-10;
const C1: f64 = 4.166_666_666_666_660_190_37e-2;
const C2: f64 = -1.388_888_888_887_410_957_49e-3;
const C3: f64 = 2.480_158_728_947_672_941_78e-5;
const C4: f64 = -2.755_731_435_139_066_330_35e-7;
const C5: f64 = 2.087_572_321_298_174_827_90e-9;
const C6: f64 = -1.135_964_755_778_819_482_65e-11;
const INVPIO2: f64 = 6.366_197_723_675_813_824_33e-1;
const PIO2_1: f64 = 1.570_796_326_734_125_614_17;
const PIO2_1T: f64 = 6.077_100_506_506_192_249_32e-11;
const PIO2_2: f64 = 6.077_100_506_303_965_976_60e-11;
const PIO2_2T: f64 = 2.022_266_248_795_950_631_54e-21;
const PIO2_3: f64 = 2.022_266_248_711_166_455_80e-21;
const PIO2_3T: f64 = 8.478_427_660_368_899_569_97e-32;

fn high(x: f64) -> i32 {
    (x.to_bits() >> 32) as i32
}

fn fma(a: f64, b: f64, c: f64) -> f64 {
    a.mul_add(b, c)
}

fn kernel_sin(x: f64, y: f64, tail: bool) -> f64 {
    if high(x) & 0x7fff_ffff < 0x3e40_0000 && x as i32 == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = fma(z, fma(z, fma(z, fma(z, S6, S5), S4), S3), S2);
    if tail {
        // x - ((z*(0.5*y - v*r) - y) - v*S1)
        x - fma(-v, S1, fma(z, fma(0.5, y, -(v * r)), -y))
    } else {
        // x + v*(S1 + z*r)
        fma(v, fma(z, r, S1), x)
    }
}

fn kernel_cos(x: f64, y: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 && x as i32 == 0 {
        return 1.0;
    }
    let z = x * x;
    let r = z * fma(z, fma(z, fma(z, fma(z, fma(z, C6, C5), C4), C3), C2), C1);
    // z*r - x*y
    let zr = fma(z, r, -(x * y));
    if ix < 0x3fd3_3333 {
        return 1.0 - fma(0.5, z, -zr);
    }
    let qx = if ix > 0x3fe9_0000 {
        0.28125
    } else {
        f64::from_bits(((ix - 0x0020_0000) as u32 as u64) << 32)
    };
    let iz = fma(0.5, z, -qx);
    let a = 1.0 - qx;
    a - (iz - zr)
}

/// High words of n·π/2 for n = 1..32 (fdlibm's quick cancellation check).
fn npio2_high(n: i32) -> i32 {
    high(n as f64 * std::f64::consts::FRAC_PI_2)
}

/// fdlibm 5.3 `__ieee754_rem_pio2` for π/4 < |x| ≤ 2^19·π/2. Callers use
/// `libm` for larger arguments, which no coordinate in degrees reaches.
fn rem_pio2(x: f64) -> (i32, f64, f64) {
    let hx = high(x);
    let ix = hx & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return (0, x, 0.0);
    }
    if ix < 0x4002_d97c {
        let sign = if hx > 0 { 1.0 } else { -1.0 };
        let mut z = x - sign * PIO2_1;
        let (y0, y1) = if ix != 0x3ff9_21fb {
            let y0 = z - sign * PIO2_1T;
            (y0, (z - y0) - sign * PIO2_1T)
        } else {
            z -= sign * PIO2_2;
            let y0 = z - sign * PIO2_2T;
            (y0, (z - y0) - sign * PIO2_2T)
        };
        return (sign as i32, y0, y1);
    }
    let t = x.abs();
    let n = fma(t, INVPIO2, 0.5) as i32;
    let f = n as f64;
    let mut r = fma(-f, PIO2_1, t);
    let mut w = f * PIO2_1T;
    let mut y0;
    if n < 32 && ix != npio2_high(n) {
        y0 = r - w;
    } else {
        let j = ix >> 20;
        y0 = r - w;
        let mut i = j - ((high(y0) >> 20) & 0x7ff);
        if i > 16 {
            let t = r;
            w = f * PIO2_2;
            r = t - w;
            w = fma(f, PIO2_2T, -((t - r) - w));
            y0 = r - w;
            i = j - ((high(y0) >> 20) & 0x7ff);
            if i > 49 {
                let t = r;
                w = f * PIO2_3;
                r = t - w;
                w = fma(f, PIO2_3T, -((t - r) - w));
                y0 = r - w;
            }
        }
    }
    let y1 = (r - y0) - w;
    if hx < 0 { (-n, -y0, -y1) } else { (n, y0, y1) }
}

pub fn sin(x: f64) -> f64 {
    if !x.is_finite() {
        return f64::NAN;
    }
    let ix = high(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_sin(x, 0.0, false);
    }
    if ix > 0x4139_21fb {
        return libm::sin(x);
    }
    let (n, y0, y1) = rem_pio2(x);
    match n & 3 {
        0 => kernel_sin(y0, y1, true),
        1 => kernel_cos(y0, y1),
        2 => -kernel_sin(y0, y1, true),
        _ => -kernel_cos(y0, y1),
    }
}

pub fn cos(x: f64) -> f64 {
    if !x.is_finite() {
        return f64::NAN;
    }
    let ix = high(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_cos(x, 0.0);
    }
    if ix > 0x4139_21fb {
        return libm::cos(x);
    }
    let (n, y0, y1) = rem_pio2(x);
    match n & 3 {
        0 => kernel_cos(y0, y1),
        1 => -kernel_sin(y0, y1, true),
        2 => -kernel_cos(y0, y1),
        _ => kernel_sin(y0, y1, true),
    }
}

const ATANHI: [f64; 4] = [
    4.636_476_090_008_060_935_15e-1,
    7.853_981_633_974_482_789_99e-1,
    9.827_937_232_473_290_540_82e-1,
    1.570_796_326_794_896_558_00,
];
const ATANLO: [f64; 4] = [
    2.269_877_745_296_168_709_24e-17,
    3.061_616_997_868_383_017_93e-17,
    1.390_331_103_123_099_845_16e-17,
    6.123_233_995_736_766_035_87e-17,
];
const AT: [f64; 11] = [
    3.333_333_333_333_293_180_27e-1,
    -1.999_999_999_987_648_324_76e-1,
    1.428_571_427_250_346_637_11e-1,
    -1.111_111_040_546_235_578_80e-1,
    9.090_887_133_436_506_561_96e-2,
    -7.691_876_205_044_829_994_95e-2,
    6.661_073_137_387_531_206_69e-2,
    -5.833_570_133_790_573_486_45e-2,
    4.976_877_994_615_932_360_17e-2,
    -3.653_157_274_421_691_552_70e-2,
    1.628_582_011_536_578_236_23e-2,
];

pub fn atan(x: f64) -> f64 {
    let hx = high(x);
    let ix = hx & 0x7fff_ffff;
    if ix >= 0x4410_0000 {
        if x.is_nan() {
            return x;
        }
        let z = ATANHI[3] + ATANLO[3];
        return if hx < 0 { -z } else { z };
    }
    let mut x = x;
    let id = if ix < 0x3fdc_0000 {
        if ix < 0x3e40_0000 {
            return x;
        }
        -1
    } else {
        x = x.abs();
        if ix < 0x3ff3_0000 {
            if ix < 0x3fe6_0000 {
                x = fma(2.0, x, -1.0) / (2.0 + x);
                0
            } else {
                x = (x - 1.0) / (x + 1.0);
                1
            }
        } else if ix < 0x4003_8000 {
            x = (x - 1.5) / fma(1.5, x, 1.0);
            2
        } else {
            x = -1.0 / x;
            3
        }
    };
    let z = x * x;
    let w = z * z;
    let s1 = z * fma(
        w,
        fma(
            w,
            fma(w, fma(w, fma(w, AT[10], AT[8]), AT[6]), AT[4]),
            AT[2],
        ),
        AT[0],
    );
    let s2 = w * fma(w, fma(w, fma(w, fma(w, AT[9], AT[7]), AT[5]), AT[3]), AT[1]);
    if id < 0 {
        return fma(-x, s1 + s2, x);
    }
    let id = id as usize;
    let z = ATANHI[id] - (fma(x, s1 + s2, -ATANLO[id]) - x);
    if hx < 0 { -z } else { z }
}

pub fn atan2(y: f64, x: f64) -> f64 {
    const PI: f64 = 3.141_592_653_589_793_116_0;
    const PI_LO: f64 = 1.224_646_799_147_353_177_2e-16;
    const PI_O_2: f64 = 1.570_796_326_794_896_558_0;
    const PI_O_4: f64 = 7.853_981_633_974_482_790_0e-1;
    if x.is_nan() || y.is_nan() {
        return x + y;
    }
    if x == 1.0 {
        return atan(y);
    }
    let (hx, hy) = (high(x), high(y));
    let m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
    if y == 0.0 {
        return match m {
            0 | 1 => y,
            2 => PI,
            _ => -PI,
        };
    }
    if x == 0.0 {
        return if hy < 0 { -PI_O_2 } else { PI_O_2 };
    }
    if x.is_infinite() {
        return if y.is_infinite() {
            match m {
                0 => PI_O_4,
                1 => -PI_O_4,
                2 => 3.0 * PI_O_4,
                _ => -3.0 * PI_O_4,
            }
        } else {
            match m {
                0 => 0.0,
                1 => -0.0,
                2 => PI,
                _ => -PI,
            }
        };
    }
    if y.is_infinite() {
        return if hy < 0 { -PI_O_2 } else { PI_O_2 };
    }
    let k = ((hy & 0x7fff_ffff) - (hx & 0x7fff_ffff)) >> 20;
    let (z, m) = if k > 60 {
        (fma(0.5, PI_LO, PI_O_2), m & 1)
    } else if hx < 0 && k < -60 {
        (0.0, m)
    } else {
        (atan((y / x).abs()), m)
    };
    match m {
        0 => z,
        1 => -z,
        2 => PI - (z - PI_LO),
        _ => (z - PI_LO) - PI,
    }
}

pub fn asin(x: f64) -> f64 {
    const PIO2_HI: f64 = 1.570_796_326_794_896_558_00;
    const PIO2_LO: f64 = 6.123_233_995_736_766_035_87e-17;
    const PIO4_HI: f64 = 7.853_981_633_974_482_789_99e-1;
    const PS: [f64; 6] = [
        1.666_666_666_666_666_574_15e-1,
        -3.255_658_186_224_009_154_05e-1,
        2.012_125_321_348_629_258_81e-1,
        -4.005_553_450_067_941_140_27e-2,
        7.915_349_942_898_145_321_76e-4,
        3.479_331_075_960_211_675_70e-5,
    ];
    const QS: [f64; 4] = [
        -2.403_394_911_734_414_218_78,
        2.020_945_760_233_505_694_71,
        -6.882_839_716_054_532_930_30e-1,
        7.703_815_055_590_193_527_91e-2,
    ];
    let p = |t: f64| {
        t * fma(
            t,
            fma(t, fma(t, fma(t, fma(t, PS[5], PS[4]), PS[3]), PS[2]), PS[1]),
            PS[0],
        )
    };
    let q = |t: f64| fma(t, fma(t, fma(t, fma(t, QS[3], QS[2]), QS[1]), QS[0]), 1.0);
    let hx = high(x);
    let ix = hx & 0x7fff_ffff;
    if ix >= 0x3ff0_0000 {
        if x.abs() == 1.0 {
            return fma(x, PIO2_HI, x * PIO2_LO);
        }
        return f64::NAN;
    }
    if ix < 0x3fe0_0000 {
        if ix < 0x3e40_0000 {
            return x;
        }
        let t = x * x;
        let w = p(t) / q(t);
        return fma(x, w, x);
    }
    let w = 1.0 - x.abs();
    let t = w * 0.5;
    let (pt, qt) = (p(t), q(t));
    let s = t.sqrt();
    let t = if ix >= 0x3fef_3333 {
        let w = pt / qt;
        PIO2_HI - fma(2.0, fma(s, w, s), -PIO2_LO)
    } else {
        let w = f64::from_bits(s.to_bits() & 0xffff_ffff_0000_0000);
        let c = fma(-w, w, t) / (s + w);
        let r = pt / qt;
        let p = fma(2.0 * s, r, -fma(-2.0, c, PIO2_LO));
        let q = fma(-2.0, w, PIO4_HI);
        PIO4_HI - (p - q)
    };
    if hx > 0 { t } else { -t }
}

/// `Math.hypot(...values)`: normalize by the largest magnitude, then a
/// Kahan-compensated sum of squares.
pub fn hypot(values: &[f64]) -> f64 {
    if values.iter().any(|v| v.is_infinite()) {
        return f64::INFINITY;
    }
    if values.iter().any(|v| v.is_nan()) {
        return f64::NAN;
    }
    let max = values.iter().fold(0.0_f64, |max, v| max.max(v.abs()));
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0_f64;
    let mut compensation = 0.0_f64;
    for value in values {
        let n = value.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

fn radians(degrees: f64) -> f64 {
    degrees * std::f64::consts::PI / 180.0
}

/// `haversineKm([leftLon, leftLat], [rightLon, rightLat])` from the compilers'
/// geometry utilities, mean Earth radius 6371.0088 km.
pub fn haversine_km(left_lon: f64, left_lat: f64, right_lon: f64, right_lat: f64) -> f64 {
    let d_lat = radians(right_lat - left_lat);
    let d_lon = radians(right_lon - left_lon);
    let latitude1 = radians(left_lat);
    let latitude2 = radians(right_lat);
    let half_lat = sin(d_lat / 2.0);
    let half_lon = sin(d_lon / 2.0);
    // `a ** 2` is `a * a` in V8; keep the source's association.
    let value = (half_lat * half_lat + cos(latitude1) * cos(latitude2) * (half_lon * half_lon))
        .clamp(0.0, 1.0);
    6371.0088 * 2.0 * atan2(value.sqrt(), (1.0 - value).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bits(text: &str) -> f64 {
        f64::from_bits(u64::from_str_radix(text, 16).unwrap())
    }

    #[test]
    fn recorded_v8_values() {
        // Node 26, macOS arm64; these differ from unfused fdlibm or libm.
        assert_eq!(
            cos(bits("3fe68706d8ebfb75")).to_bits(),
            0x3fe8_6484_d236_6a62
        );
        assert_eq!(
            sin(bits("3fe603390d29e446")).to_bits(),
            0x3fe4_5131_085a_5fd3
        );
        assert_eq!(
            sin(bits("3fe5ee643dd4882a")).to_bits(),
            0x3fe4_4114_ae99_990d
        );
    }

    #[test]
    fn hypot_follows_v8() {
        assert_eq!(hypot(&[3.0, 4.0]), 5.0);
        assert_eq!(hypot(&[0.0, -0.0]), 0.0);
        assert!(hypot(&[f64::NAN, f64::INFINITY]).is_infinite());
        assert!(hypot(&[f64::NAN, 1.0]).is_nan());
    }

    #[test]
    fn reduction_table_matches_fdlibm() {
        let table = [
            0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB,
            0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB,
            0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C,
            0x4041475C, 0x4042106C, 0x4042D97C, 0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB,
            0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
        ];
        for (index, expected) in table.iter().enumerate() {
            assert_eq!(npio2_high(index as i32 + 1), *expected, "n={}", index + 1);
        }
    }

    #[test]
    fn reduced_arguments_agree_with_identities() {
        for i in 0..20_000 {
            let x = -40.0 + i as f64 * 0.004_01;
            assert!((sin(x) - x.sin()).abs() <= 2.0 * f64::EPSILON, "{x}");
            assert!((cos(x) - x.cos()).abs() <= 2.0 * f64::EPSILON, "{x}");
        }
    }
}
