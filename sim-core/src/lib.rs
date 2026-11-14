//! sim-core: ocean sound-ray tracing and bearings-only tracking.
//!
//! Every formula and constant here comes from a public source listed in
//! SOURCES.md, or is an invented game value and is marked FICTIONAL.
//! No dependencies: the crate compiles to plain WebAssembly and to native
//! code for tests.

use std::cell::UnsafeCell;
use std::f64::consts::PI;

// ---------------------------------------------------------------- constants

/// Water depth of the canonical Munk test case, metres. [SRC: munk-profile]
pub const WATER_DEPTH: f64 = 5000.0;
/// Munk profile: sound speed at the channel axis, m/s. [SRC: munk-profile]
pub const MUNK_C0: f64 = 1500.0;
/// Munk profile: scale depth, metres. [SRC: munk-profile]
pub const MUNK_B: f64 = 1300.0;
/// Munk profile: perturbation coefficient. [SRC: munk-profile]
pub const MUNK_EPS: f64 = 0.00737;
/// Metres per second in one knot (exact: 1852 m / 3600 s). [SRC: units]
pub const KNOT: f64 = 1852.0 / 3600.0;

// Game values. FICTIONAL: invented for this simulation, not real systems.
/// FICTIONAL source level of the invented contact, dB.
pub const FICT_SOURCE_LEVEL: f64 = 165.0;
/// FICTIONAL frequency of the invented contact's noise, kHz.
pub const FICT_FREQ_KHZ: f64 = 0.3;
/// FICTIONAL background noise level, dB.
pub const FICT_NOISE_LEVEL: f64 = 70.0;
/// FICTIONAL directivity index of the invented listening array, dB.
pub const FICT_DIRECTIVITY: f64 = 18.0;
/// FICTIONAL extra loss when only bottom-bounce paths reach the contact, dB.
pub const FICT_BOUNCE_PENALTY: f64 = 15.0;
/// FICTIONAL extra loss when no traced path reaches the contact, dB.
pub const FICT_SHADOW_PENALTY: f64 = 30.0;
/// FICTIONAL signal excess below which the contact is not heard, dB.
pub const FICT_DETECT_FLOOR: f64 = -3.0;
/// FICTIONAL depth of the invented surface contact's noise source, metres.
pub const FICT_CONTACT_DEPTH: f64 = 10.0;

/// Seconds between bearing measurements.
pub const DT: f64 = 30.0;
/// Ray fan: number of rays traced (see fan_angles).
pub const N_RAYS: usize = 181;
/// Every DRAW_EVERY-th ray is exported for drawing.
pub const DRAW_EVERY: usize = 3;
pub const N_DRAW_RAYS: usize = (N_RAYS + DRAW_EVERY - 1) / DRAW_EVERY;
pub const MAX_RANGE: f64 = 100_000.0;
pub const RAY_STEP: f64 = 100.0;
pub const RAY_STRIDE: usize = 3;
pub const RAY_PTS: usize = 360;
/// FICTIONAL simplification: a path is dropped after this many sea-floor bounces.
pub const MAX_BOTTOM_BOUNCES: u32 = 2;
/// Coverage grid: range bins of 500 m, depth bins of 100 m.
pub const COV_NR: usize = 200;
pub const COV_NZ: usize = 50;
pub const N_PARTICLES: usize = 6000;
/// Fraction of the optimal kernel bandwidth used when regularising. [SRC: particle-filter]
pub const KERNEL_SCALE: f64 = 0.5;
pub const N_DRAW_PARTICLES: usize = 500;
pub const OUT_HEAD: usize = 32;
pub const N_PROFILE: usize = 101;

// ---------------------------------------------------------------------- rng

/// SplitMix64: small, fast, seedable, so every run can be repeated exactly.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xD1B5_4A32_D192_ED03)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1).
    pub fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    /// Standard normal by the Box-Muller transform.
    pub fn normal(&mut self) -> f64 {
        let u1 = self.uniform().max(1e-300);
        let u2 = self.uniform();
        (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos()
    }
}

// -------------------------------------------------------------------- ocean

/// Sound speed as a function of depth.
#[derive(Clone, Copy, Debug)]
pub enum Profile {
    /// Munk's canonical deep-ocean profile with a movable channel axis.
    Munk { axis: f64 },
    /// Constant gradient, used in tests because its rays are exact circles.
    Linear { c0: f64, g: f64 },
}

impl Profile {
    /// Sound speed in m/s at depth z metres. [SRC: munk-profile]
    pub fn c(&self, z: f64) -> f64 {
        match *self {
            Profile::Munk { axis } => {
                let eta = 2.0 * (z - axis) / MUNK_B;
                MUNK_C0 * (1.0 + MUNK_EPS * (eta - 1.0 + (-eta).exp()))
            }
            Profile::Linear { c0, g } => c0 + g * z,
        }
    }
    /// Sound speed and its depth derivative together (one exponential).
    pub fn c_and_dcdz(&self, z: f64) -> (f64, f64) {
        match *self {
            Profile::Munk { axis } => {
                let eta = 2.0 * (z - axis) / MUNK_B;
                let e = (-eta).exp();
                (
                    MUNK_C0 * (1.0 + MUNK_EPS * (eta - 1.0 + e)),
                    MUNK_C0 * MUNK_EPS * (2.0 / MUNK_B) * (1.0 - e),
                )
            }
            Profile::Linear { c0, g } => (c0 + g * z, g),
        }
    }
    /// Derivative of sound speed with depth, 1/s.
    pub fn dcdz(&self, z: f64) -> f64 {
        match *self {
            Profile::Munk { axis } => {
                let eta = 2.0 * (z - axis) / MUNK_B;
                MUNK_C0 * MUNK_EPS * (2.0 / MUNK_B) * (1.0 - (-eta).exp())
            }
            Profile::Linear { g, .. } => g,
        }
    }
}

/// The profile sampled every metre, so the ray tracer reads sound speed and
/// its gradient by linear interpolation instead of calling exp() four times
/// a step. Extends past both boundaries because Runge-Kutta stages can
/// briefly overshoot them.
pub struct Table {
    c: Vec<f64>,
    dc: Vec<f64>,
}

const TABLE_PAD: f64 = 300.0;

impl Table {
    pub fn new(p: &Profile) -> Self {
        let n = (WATER_DEPTH + 2.0 * TABLE_PAD) as usize + 2;
        let mut t = Table { c: Vec::with_capacity(n), dc: Vec::with_capacity(n) };
        for i in 0..n {
            let (c, dc) = p.c_and_dcdz(i as f64 - TABLE_PAD);
            t.c.push(c);
            t.dc.push(dc);
        }
        t
    }
    #[inline]
    pub fn at(&self, z: f64) -> (f64, f64) {
        let u = (z + TABLE_PAD).clamp(0.0, (self.c.len() - 2) as f64);
        let i = u as usize;
        let f = u - i as f64;
        (
            self.c[i] + f * (self.c[i + 1] - self.c[i]),
            self.dc[i] + f * (self.dc[i + 1] - self.dc[i]),
        )
    }
}

// --------------------------------------------------------------------- rays

pub struct Ray {
    /// (range m, depth m, bottom bounces so far), every RAY_STRIDE steps.
    pub pts: Vec<(f32, f32, f32)>,
    pub bottom_bounces: u32,
    pub surface_bounces: u32,
    /// Largest relative change of the Snell invariant cos(theta)/c.
    pub snell_drift: f64,
    pub max_depth: f64,
}

/// Trace one ray in the range-depth plane. theta is the launch angle from
/// the horizontal, positive downward. With xi = cos(theta)/c and
/// zeta = sin(theta)/c the ray equations are
///   dr/ds = c xi,  dz/ds = c zeta,  dxi/ds = 0,  dzeta/ds = -(1/c^2) dc/dz,
/// integrated with fourth-order Runge-Kutta. xi is constant because the
/// ocean here does not change with range: that is Snell's law.
/// [SRC: ray-equations]
pub fn trace_ray(
    p: &Table,
    z0: f64,
    theta0: f64,
    max_range: f64,
    max_bottom: u32,
    mut visit: impl FnMut(f64, f64, u32),
) -> Ray {
    let ds = RAY_STEP;
    let c0 = p.at(z0).0;
    let xi = theta0.cos() / c0;
    let (mut r, mut z, mut zeta) = (0.0f64, z0, theta0.sin() / c0);
    let mut ray = Ray {
        pts: Vec::with_capacity(RAY_PTS),
        bottom_bounces: 0,
        surface_bounces: 0,
        snell_drift: 0.0,
        max_depth: z0,
    };
    let f = |z: f64, zeta: f64| -> (f64, f64, f64) {
        let (c, dc) = p.at(z);
        (c * xi, c * zeta, -dc / (c * c))
    };
    let rk4 = |z: f64, zeta: f64, h: f64| -> (f64, f64, f64) {
        let (a1, b1, c1) = f(z, zeta);
        let (a2, b2, c2) = f(z + 0.5 * h * b1, zeta + 0.5 * h * c1);
        let (a3, b3, c3) = f(z + 0.5 * h * b2, zeta + 0.5 * h * c2);
        let (a4, b4, c4) = f(z + h * b3, zeta + h * c3);
        (
            h / 6.0 * (a1 + 2.0 * a2 + 2.0 * a3 + a4),
            h / 6.0 * (b1 + 2.0 * b2 + 2.0 * b3 + b4),
            h / 6.0 * (c1 + 2.0 * c2 + 2.0 * c3 + c4),
        )
    };
    let mut step = 0usize;
    ray.pts.push((r as f32, z as f32, 0.0));
    while r < max_range && ray.pts.len() < RAY_PTS {
        let (dr, dz, dzeta) = rk4(z, zeta, ds);
        let zn = z + dz;
        if zn < 0.0 || zn > WATER_DEPTH {
            // The step crosses the sea surface or the flat sea floor: take
            // the shorter step that lands on the boundary, then mirror.
            let wall = if zn < 0.0 { 0.0 } else { WATER_DEPTH };
            let frac = ((wall - z) / dz).clamp(0.0, 1.0);
            let (dr, _, dzeta) = rk4(z, zeta, ds * frac);
            r += dr;
            z = wall;
            zeta = -(zeta + dzeta);
            if wall == 0.0 {
                ray.surface_bounces += 1;
            } else {
                ray.bottom_bounces += 1;
                if ray.bottom_bounces > max_bottom {
                    ray.pts.push((r as f32, z as f32, ray.bottom_bounces as f32));
                    break;
                }
            }
        } else {
            r += dr;
            z = zn;
            zeta += dzeta;
        }
        // The direction vector must keep length 1/c. Its drift measures the
        // integration error, and equals the drift of cos(theta)/c.
        let drift = (p.at(z).0 * (xi * xi + zeta * zeta).sqrt() - 1.0).abs();
        if drift > ray.snell_drift {
            ray.snell_drift = drift;
        }
        if z > ray.max_depth {
            ray.max_depth = z;
        }
        visit(r, z, ray.bottom_bounces);
        step += 1;
        if step % RAY_STRIDE == 0 {
            ray.pts.push((r as f32, z as f32, ray.bottom_bounces as f32));
        }
    }
    ray
}

/// Launch angles in degrees: a fine fan of shallow rays that the ocean bends
/// back before the sea floor, plus a coarser set of steep rays that reach
/// the contact by bouncing off the sea floor.
pub fn fan_angles() -> Vec<f64> {
    let mut v = Vec::with_capacity(N_RAYS);
    for i in 0..121 {
        v.push(-15.0 + 0.25 * i as f64);
    }
    for j in 0..30 {
        let a = 16.5 + 1.5 * j as f64;
        v.push(a);
        v.push(-a);
    }
    v
}

/// Which kind of traced path reaches each cell of the range-depth grid.
/// 2 = a path that never touched the sea floor, 1 = only paths that bounced
/// off the sea floor, 0 = no traced path (a shadow zone).
pub struct Coverage {
    pub cells: Vec<u8>,
}

impl Coverage {
    pub fn new() -> Self {
        Coverage { cells: vec![0; COV_NR * COV_NZ] }
    }
    fn mark(&mut self, r: f64, z: f64, bottom: u32) {
        let ir = (r / (MAX_RANGE / COV_NR as f64)) as usize;
        let iz = (z / (WATER_DEPTH / COV_NZ as f64)) as usize;
        if ir < COV_NR && iz < COV_NZ {
            let v = if bottom == 0 { 2 } else { 1 };
            let cell = &mut self.cells[iz * COV_NR + ir];
            if v > *cell {
                *cell = v;
            }
        }
    }
    /// Best path kind within one range bin either side of (r, z).
    pub fn zone(&self, r: f64, z: f64) -> u8 {
        let ir = ((r / (MAX_RANGE / COV_NR as f64)) as isize).clamp(0, COV_NR as isize - 1);
        let iz = ((z / (WATER_DEPTH / COV_NZ as f64)) as usize).min(COV_NZ - 1);
        let mut best = 0;
        for d in -1..=1isize {
            let j = ir + d;
            if j >= 0 && (j as usize) < COV_NR {
                best = best.max(self.cells[iz * COV_NR + j as usize]);
            }
        }
        best
    }
}

// -------------------------------------------------------------------- sonar

/// Thorp's formula for sound absorption in seawater, dB per km, with the
/// frequency in kHz. [SRC: thorp]
pub fn thorp_db_per_km(f_khz: f64) -> f64 {
    let f2 = f_khz * f_khz;
    0.11 * f2 / (1.0 + f2) + 44.0 * f2 / (4100.0 + f2) + 2.75e-4 * f2 + 0.003
}

/// Transmission loss in dB: spherical spreading out to one water depth, then
/// cylindrical spreading, plus absorption. A textbook simplification.
/// [SRC: sonar-equation]
pub fn transmission_loss(range_m: f64, f_khz: f64) -> f64 {
    let r = range_m.max(1.0);
    let rt = WATER_DEPTH;
    let spreading = if r <= rt {
        20.0 * r.log10()
    } else {
        20.0 * rt.log10() + 10.0 * (r / rt).log10()
    };
    spreading + thorp_db_per_km(f_khz) * r / 1000.0
}

/// Passive sonar equation: signal excess = SL - TL - NL + DI, less the
/// FICTIONAL path penalty for the zone the contact sits in.
/// [SRC: sonar-equation]
pub fn signal_excess(range_m: f64, zone: u8) -> f64 {
    let penalty = match zone {
        2 => 0.0,
        1 => FICT_BOUNCE_PENALTY,
        _ => FICT_SHADOW_PENALTY,
    };
    FICT_SOURCE_LEVEL - transmission_loss(range_m, FICT_FREQ_KHZ) - FICT_NOISE_LEVEL
        + FICT_DIRECTIVITY
        - penalty
}

/// FICTIONAL mapping from signal excess to bearing error (one standard
/// deviation, degrees): a weaker signal gives a blurrier bearing.
pub fn bearing_sigma_deg(se: f64) -> f64 {
    (1.5 * 10f64.powf(-(se - 20.0) / 20.0)).clamp(0.3, 12.0)
}

fn wrap_pi(a: f64) -> f64 {
    let mut a = a % (2.0 * PI);
    if a > PI {
        a -= 2.0 * PI;
    } else if a < -PI {
        a += 2.0 * PI;
    }
    a
}

// ----------------------------------------------------------------- tracking

/// Bootstrap particle filter for bearings-only tracking of a contact that
/// holds a steady course and speed. State per particle: position (m) and
/// velocity (m/s) on a flat north-east plane.
/// [SRC: particle-filter] [SRC: bearings-only]
pub struct Filter {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    pub w: Vec<f64>,
    pub started: bool,
    pub ess_frac: f64,
    scratch: Vec<usize>,
}

pub struct Estimate {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub cxx: f64,
    pub cxy: f64,
    pub cyy: f64,
}

impl Filter {
    pub fn new() -> Self {
        let n = N_PARTICLES;
        Filter {
            x: vec![0.0; n],
            y: vec![0.0; n],
            vx: vec![0.0; n],
            vy: vec![0.0; n],
            w: vec![1.0 / n as f64; n],
            started: false,
            ess_frac: 1.0,
            scratch: vec![0; n],
        }
    }

    /// Spread particles along the first bearing: any range from 2 to 100 km,
    /// any course, any speed from 2 to 22 knots.
    fn start(&mut self, ox: f64, oy: f64, bearing: f64, sigma: f64, rng: &mut Rng) {
        for i in 0..N_PARTICLES {
            let range = 2000.0 + 98_000.0 * rng.uniform();
            let b = bearing + sigma * rng.normal();
            let course = 2.0 * PI * rng.uniform();
            let speed = (2.0 + 20.0 * rng.uniform()) * KNOT;
            self.x[i] = ox + range * b.sin();
            self.y[i] = oy + range * b.cos();
            self.vx[i] = speed * course.sin();
            self.vy[i] = speed * course.cos();
            self.w[i] = 1.0 / N_PARTICLES as f64;
        }
        self.started = true;
    }

    fn predict(&mut self, rng: &mut Rng) {
        // Small random velocity change so the cloud cannot collapse to a point.
        let q = 0.004;
        for i in 0..N_PARTICLES {
            self.vx[i] += q * rng.normal();
            self.vy[i] += q * rng.normal();
            self.x[i] += self.vx[i] * DT;
            self.y[i] += self.vy[i] * DT;
        }
    }

    fn update(&mut self, ox: f64, oy: f64, bearing: f64, sigma: f64, rng: &mut Rng) {
        let s = sigma.max(0.5f64.to_radians()) * 1.2;
        let mut sum = 0.0;
        for i in 0..N_PARTICLES {
            let pb = (self.x[i] - ox).atan2(self.y[i] - oy);
            let res = wrap_pi(pb - bearing) / s;
            self.w[i] *= (-0.5 * res * res).exp();
            sum += self.w[i];
        }
        if sum <= 1e-300 {
            let u = 1.0 / N_PARTICLES as f64;
            self.w.iter_mut().for_each(|w| *w = u);
        } else {
            self.w.iter_mut().for_each(|w| *w /= sum);
        }
        let ess = 1.0 / self.w.iter().map(|w| w * w).sum::<f64>();
        self.ess_frac = ess / N_PARTICLES as f64;
        if self.ess_frac < 0.5 {
            self.resample(rng);
        }
    }

    /// Systematic resampling followed by regularisation: each copy is moved
    /// by a random draw shaped like the cloud itself (its 4-by-4 covariance,
    /// scaled by a kernel bandwidth), so duplicates spread out without
    /// changing the cloud's shape. [SRC: particle-filter]
    fn resample(&mut self, rng: &mut Rng) {
        let n = N_PARTICLES;
        let chol = self.cholesky();
        let step = 1.0 / n as f64;
        let mut u = rng.uniform() * step;
        let mut c = self.w[0];
        let mut i = 0;
        for j in 0..n {
            while u > c && i < n - 1 {
                i += 1;
                c += self.w[i];
            }
            self.scratch[j] = i;
            u += step;
        }
        let pick = |v: &Vec<f64>, idx: &Vec<usize>| -> Vec<f64> { idx.iter().map(|&k| v[k]).collect() };
        self.x = pick(&self.x, &self.scratch);
        self.y = pick(&self.y, &self.scratch);
        self.vx = pick(&self.vx, &self.scratch);
        self.vy = pick(&self.vy, &self.scratch);
        // Optimal Gaussian-kernel bandwidth for a 4-dimensional state.
        let h = KERNEL_SCALE * (4.0f64 / 6.0).powf(1.0 / 8.0) * (n as f64).powf(-1.0 / 8.0);
        for k in 0..n {
            let g = [rng.normal(), rng.normal(), rng.normal(), rng.normal()];
            let mut d = [0.0; 4];
            for a in 0..4 {
                for b in 0..=a {
                    d[a] += chol[a][b] * g[b];
                }
            }
            self.x[k] += h * d[0];
            self.y[k] += h * d[1];
            self.vx[k] += h * d[2];
            self.vy[k] += h * d[3];
            self.w[k] = step;
        }
    }

    /// Lower-triangular Cholesky factor of the weighted 4-by-4 covariance.
    fn cholesky(&self) -> [[f64; 4]; 4] {
        let cols = [&self.x, &self.y, &self.vx, &self.vy];
        let mut mean = [0.0; 4];
        for i in 0..N_PARTICLES {
            for a in 0..4 {
                mean[a] += self.w[i] * cols[a][i];
            }
        }
        let mut cov = [[0.0; 4]; 4];
        for i in 0..N_PARTICLES {
            let d = [cols[0][i] - mean[0], cols[1][i] - mean[1], cols[2][i] - mean[2], cols[3][i] - mean[3]];
            for a in 0..4 {
                for b in 0..=a {
                    cov[a][b] += self.w[i] * d[a] * d[b];
                }
            }
        }
        let mut l = [[0.0; 4]; 4];
        for a in 0..4 {
            for b in 0..=a {
                let mut sum = cov[a][b];
                for k in 0..b {
                    sum -= l[a][k] * l[b][k];
                }
                l[a][b] = if a == b { sum.max(1e-12).sqrt() } else { sum / l[b][b] };
            }
        }
        l
    }

    pub fn estimate(&self) -> Estimate {
        let (mut x, mut y, mut vx, mut vy) = (0.0, 0.0, 0.0, 0.0);
        for i in 0..N_PARTICLES {
            let w = self.w[i];
            x += w * self.x[i];
            y += w * self.y[i];
            vx += w * self.vx[i];
            vy += w * self.vy[i];
        }
        let (mut cxx, mut cxy, mut cyy) = (0.0, 0.0, 0.0);
        for i in 0..N_PARTICLES {
            let w = self.w[i];
            let dx = self.x[i] - x;
            let dy = self.y[i] - y;
            cxx += w * dx * dx;
            cxy += w * dx * dy;
            cyy += w * dy * dy;
        }
        Estimate { x, y, vx, vy, cxx, cxy, cyy }
    }
}

// ----------------------------------------------------------------- scenario

pub struct Scenario {
    pub t: f64,
    pub step: u32,
    pub ox: f64,
    pub oy: f64,
    pub ocourse: f64,
    pub ospeed: f64,
    pub cx: f64,
    pub cy: f64,
    pub cvx: f64,
    pub cvy: f64,
}

impl Scenario {
    /// FICTIONAL contact: starts 20 to 65 km away on any bearing, holds any
    /// course at 8 to 18 knots.
    pub fn new(rng: &mut Rng) -> Self {
        let range = 20_000.0 + 45_000.0 * rng.uniform();
        let bearing = 2.0 * PI * rng.uniform();
        let course = 2.0 * PI * rng.uniform();
        let speed = (8.0 + 10.0 * rng.uniform()) * KNOT;
        Scenario {
            t: 0.0,
            step: 0,
            ox: 0.0,
            oy: 0.0,
            ocourse: 0.0,
            ospeed: 8.0 * KNOT,
            cx: range * bearing.sin(),
            cy: range * bearing.cos(),
            cvx: speed * course.sin(),
            cvy: speed * course.cos(),
        }
    }
    pub fn range(&self) -> f64 {
        ((self.cx - self.ox).powi(2) + (self.cy - self.oy).powi(2)).sqrt()
    }
}

// ---------------------------------------------------------------- simulator

pub struct Sim {
    pub profile: Profile,
    pub src_depth: f64,
    pub coverage: Coverage,
    pub rays: Vec<f32>,
    pub profile_out: Vec<f32>,
    pub out: Vec<f32>,
    pub max_snell_drift: f64,
    pub scenario: Scenario,
    pub filter: Filter,
    pub rng: Rng,
}

impl Sim {
    pub fn new() -> Self {
        let mut rng = Rng::new(1);
        let scenario = Scenario::new(&mut rng);
        let mut s = Sim {
            profile: Profile::Munk { axis: 1300.0 },
            src_depth: 300.0,
            coverage: Coverage::new(),
            rays: vec![f32::NAN; N_DRAW_RAYS * RAY_PTS * 3],
            profile_out: vec![0.0; N_PROFILE],
            out: vec![0.0; OUT_HEAD + 2 * N_DRAW_PARTICLES],
            max_snell_drift: 0.0,
            scenario,
            filter: Filter::new(),
            rng,
        };
        s.trace(300.0);
        s
    }

    /// Trace the fan of rays from the listening depth, rebuild the coverage
    /// grid and the drawing buffers. By reciprocity the paths from listener
    /// to contact are the paths from contact to listener.
    pub fn trace(&mut self, src_depth: f64) {
        self.src_depth = src_depth.clamp(10.0, WATER_DEPTH - 10.0);
        self.coverage = Coverage::new();
        self.rays.iter_mut().for_each(|v| *v = f32::NAN);
        self.max_snell_drift = 0.0;
        let table = Table::new(&self.profile);
        for (i, a) in fan_angles().into_iter().enumerate() {
            let th = a.to_radians();
            let cov = &mut self.coverage;
            let ray = trace_ray(&table, self.src_depth, th, MAX_RANGE, MAX_BOTTOM_BOUNCES, |r, z, b| cov.mark(r, z, b));
            if ray.snell_drift > self.max_snell_drift {
                self.max_snell_drift = ray.snell_drift;
            }
            if i % DRAW_EVERY == 0 {
                let base = (i / DRAW_EVERY) * RAY_PTS * 3;
                for (k, p) in ray.pts.iter().enumerate() {
                    self.rays[base + 3 * k] = p.0;
                    self.rays[base + 3 * k + 1] = p.1;
                    self.rays[base + 3 * k + 2] = p.2;
                }
            }
        }
        for i in 0..N_PROFILE {
            let z = WATER_DEPTH * i as f64 / (N_PROFILE - 1) as f64;
            self.profile_out[i] = self.profile.c(z) as f32;
        }
    }

    pub fn reset(&mut self, seed: u64) {
        self.rng = Rng::new(seed);
        self.scenario = Scenario::new(&mut self.rng);
        self.filter = Filter::new();
        self.write_out(false, 0.0, 0.0, 0.0, 0);
    }

    /// Advance one measurement interval with the ordered course and speed.
    pub fn step(&mut self, course_deg: f64, speed_kn: f64) {
        let sc = &mut self.scenario;
        // Own ship turns toward the ordered course at up to 1 degree a second.
        let want = course_deg.to_radians();
        let max_turn = (1.0f64).to_radians() * DT;
        let diff = wrap_pi(want - sc.ocourse);
        sc.ocourse = wrap_pi(sc.ocourse + diff.clamp(-max_turn, max_turn));
        sc.ospeed = speed_kn.clamp(0.0, 20.0) * KNOT;
        sc.ox += sc.ospeed * sc.ocourse.sin() * DT;
        sc.oy += sc.ospeed * sc.ocourse.cos() * DT;
        sc.cx += sc.cvx * DT;
        sc.cy += sc.cvy * DT;
        sc.t += DT;
        sc.step += 1;

        let range = sc.range();
        let zone = self.coverage.zone(range, FICT_CONTACT_DEPTH);
        let se = signal_excess(range, zone);
        let sigma = bearing_sigma_deg(se).to_radians();
        let detected = se >= FICT_DETECT_FLOOR;
        let true_bearing = (sc.cx - sc.ox).atan2(sc.cy - sc.oy);
        let meas = wrap_pi(true_bearing + sigma * self.rng.normal());
        let (ox, oy) = (sc.ox, sc.oy);
        if self.filter.started {
            self.filter.predict(&mut self.rng);
        }
        if detected {
            if !self.filter.started {
                self.filter.start(ox, oy, meas, sigma, &mut self.rng);
            } else {
                self.filter.update(ox, oy, meas, sigma, &mut self.rng);
            }
        }
        self.write_out(detected, meas, sigma, se, zone);
    }

    fn write_out(&mut self, detected: bool, meas: f64, sigma: f64, se: f64, zone: u8) {
        let sc = &self.scenario;
        let deg = |a: f64| -> f32 { ((a.to_degrees() % 360.0 + 360.0) % 360.0) as f32 };
        let o = &mut self.out;
        o[0] = sc.t as f32;
        o[1] = (sc.ox / 1000.0) as f32;
        o[2] = (sc.oy / 1000.0) as f32;
        o[3] = deg(sc.ocourse);
        o[4] = (sc.ospeed / KNOT) as f32;
        o[5] = if detected { 1.0 } else { 0.0 };
        o[6] = deg(meas);
        o[7] = sigma.to_degrees() as f32;
        o[8] = se as f32;
        o[9] = zone as f32;
        o[19] = sc.step as f32;
        o[20] = (sc.cx / 1000.0) as f32;
        o[21] = (sc.cy / 1000.0) as f32;
        o[22] = deg(sc.cvx.atan2(sc.cvy));
        o[23] = ((sc.cvx * sc.cvx + sc.cvy * sc.cvy).sqrt() / KNOT) as f32;
        o[24] = (sc.range() / 1000.0) as f32;
        o[26] = if self.filter.started { 1.0 } else { 0.0 };
        if self.filter.started {
            let e = self.filter.estimate();
            o[10] = (e.x / 1000.0) as f32;
            o[11] = (e.y / 1000.0) as f32;
            o[12] = (e.cxx / 1e6) as f32;
            o[13] = (e.cxy / 1e6) as f32;
            o[14] = (e.cyy / 1e6) as f32;
            o[15] = (((e.x - sc.ox).powi(2) + (e.y - sc.oy).powi(2)).sqrt() / 1000.0) as f32;
            o[16] = deg(e.vx.atan2(e.vy));
            o[17] = ((e.vx * e.vx + e.vy * e.vy).sqrt() / KNOT) as f32;
            o[18] = self.filter.ess_frac as f32;
            let stride = N_PARTICLES / N_DRAW_PARTICLES;
            for k in 0..N_DRAW_PARTICLES {
                o[OUT_HEAD + 2 * k] = (self.filter.x[k * stride] / 1000.0) as f32;
                o[OUT_HEAD + 2 * k + 1] = (self.filter.y[k * stride] / 1000.0) as f32;
            }
        }
    }
}

// --------------------------------------------------------- WebAssembly API

struct Global(UnsafeCell<Option<Sim>>);
// The module runs on one thread (a Web Worker), so this is never shared.
unsafe impl Sync for Global {}
static SIM: Global = Global(UnsafeCell::new(None));

fn sim() -> &'static mut Sim {
    unsafe { (*SIM.0.get()).get_or_insert_with(Sim::new) }
}

#[no_mangle]
pub extern "C" fn sc_set_axis(axis_m: f64) {
    sim().profile = Profile::Munk { axis: axis_m.clamp(300.0, 2500.0) };
}
#[no_mangle]
pub extern "C" fn sc_trace(src_depth_m: f64) {
    sim().trace(src_depth_m);
}
#[no_mangle]
pub extern "C" fn sc_reset(seed: u32) {
    sim().reset(seed as u64);
}
#[no_mangle]
pub extern "C" fn sc_step(course_deg: f64, speed_kn: f64) {
    sim().step(course_deg, speed_kn);
}
#[no_mangle]
pub extern "C" fn sc_rays_ptr() -> *const f32 {
    sim().rays.as_ptr()
}
#[no_mangle]
pub extern "C" fn sc_profile_ptr() -> *const f32 {
    sim().profile_out.as_ptr()
}
#[no_mangle]
pub extern "C" fn sc_coverage_ptr() -> *const u8 {
    sim().coverage.cells.as_ptr()
}
#[no_mangle]
pub extern "C" fn sc_out_ptr() -> *const f32 {
    sim().out.as_ptr()
}
#[no_mangle]
pub extern "C" fn sc_snell_drift() -> f64 {
    sim().max_snell_drift
}
#[no_mangle]
pub extern "C" fn sc_layout(i: u32) -> u32 {
    [N_DRAW_RAYS, RAY_PTS, COV_NR, COV_NZ, N_PROFILE, OUT_HEAD, N_DRAW_PARTICLES, N_PARTICLES, N_RAYS][i as usize] as u32
}

#[cfg(test)]
mod tests;
