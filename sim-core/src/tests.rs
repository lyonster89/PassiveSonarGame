use super::*;

#[test]
fn munk_profile_has_its_minimum_at_the_axis() {
    let p = Profile::Munk { axis: 1300.0 };
    assert!((p.c(1300.0) - MUNK_C0).abs() < 1e-9);
    assert!(p.dcdz(1300.0).abs() < 1e-12);
    assert!(p.c(0.0) > p.c(1300.0) && p.c(5000.0) > p.c(1300.0));
    // derivative matches a finite difference
    for z in [50.0, 800.0, 2500.0, 4800.0] {
        let fd = (p.c(z + 0.5) - p.c(z - 0.5)) / 1.0;
        assert!((fd - p.dcdz(z)).abs() < 1e-6);
    }
}

#[test]
fn rays_keep_their_snell_invariant() {
    let p = Profile::Munk { axis: 1300.0 };
    let mut worst: f64 = 0.0;
    for depth in [50.0, 300.0, 1300.0, 3000.0] {
        for i in 0..=60 {
            let th = (-15.0 + 0.5 * i as f64).to_radians();
            let ray = trace_ray(&Table::new(&p), depth, th, MAX_RANGE, 99, |_, _, _| {});
            worst = worst.max(ray.snell_drift);
        }
    }
    println!("worst Snell drift: {:.3e} (limit 1e-3)", worst);
    assert!(worst < 1e-3);
}

#[test]
fn constant_gradient_ray_is_a_circle() {
    // In c = c0 + g z a horizontally launched ray is an arc of a circle
    // centred where c would be zero, with radius c(z0)/g.
    let (c0, g, z0) = (1500.0, 0.017, 2000.0);
    let p = Profile::Linear { c0, g };
    let zc = -c0 / g;
    let radius = z0 - zc;
    let mut worst: f64 = 0.0;
    trace_ray(&Table::new(&p), z0, 0.0, 15_000.0, 99, |r, z, _| {
        let exact = zc + (radius * radius - r * r).sqrt();
        worst = worst.max((z - exact).abs());
    });
    println!("circle test worst depth error: {:.4} m over 15 km", worst);
    assert!(worst < 0.5);
    assert_eq!(fan_angles().len(), N_RAYS);
}

#[test]
fn ray_turns_at_the_depth_snells_law_predicts() {
    let p = Profile::Munk { axis: 1300.0 };
    let th: f64 = 5.0f64.to_radians();
    let ray = trace_ray(&Table::new(&p), 1300.0, th, 60_000.0, 99, |_, _, _| {});
    // lower turning depth: c(z) = c(z0) / cos(theta0), solved by bisection
    let target = p.c(1300.0) / th.cos();
    let (mut lo, mut hi) = (1300.0, WATER_DEPTH);
    for _ in 0..60 {
        let mid = 0.5 * (lo + hi);
        if p.c(mid) < target { lo = mid } else { hi = mid }
    }
    println!("turning depth traced {:.1} m, predicted {:.1} m", ray.max_depth, lo);
    assert!(ray.bottom_bounces == 0);
    assert!((ray.max_depth - lo).abs() < 5.0);
}

#[test]
fn thorp_and_spreading_are_sane() {
    let a = thorp_db_per_km(1.0);
    assert!(a > 0.06 && a < 0.08, "{}", a);
    assert!((transmission_loss(1000.0, 0.0001) - 60.0).abs() < 0.1);
    assert!(transmission_loss(50_000.0, 0.3) > transmission_loss(10_000.0, 0.3));
    assert!(bearing_sigma_deg(30.0) < bearing_sigma_deg(5.0));
}

#[test]
fn same_seed_gives_the_same_run() {
    let run = |seed| {
        let mut s = Sim::new();
        s.reset(seed);
        for k in 0..120 {
            s.step(if k < 50 { 0.0 } else { 110.0 }, 12.0);
        }
        s.out.clone()
    };
    let (a, b) = (run(7), run(7));
    assert!(a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()));
    assert!(run(8) != a);
}

fn script(k: u32) -> f64 {
    if k < 60 { 0.0 } else if k < 140 { 110.0 } else { 340.0 }
}

#[test]
fn filter_finds_the_contact_after_own_ship_turns() {
    let mut before = vec![];
    let mut after = vec![];
    let mut inside = 0;
    let mut counted = 0;
    for seed in 1..=100u64 {
        let mut s = Sim::new();
        s.reset(seed);
        let mut err_before = f64::NAN;
        for k in 0..240 {
            s.step(script(k), 12.0);
            if k == 59 && s.filter.started {
                let e = s.filter.estimate();
                let sc = &s.scenario;
                err_before = ((e.x - sc.cx).powi(2) + (e.y - sc.cy).powi(2)).sqrt() / sc.range();
            }
        }
        if !s.filter.started { continue; }
        let e = s.filter.estimate();
        let sc = &s.scenario;
        let (dx, dy) = (sc.cx - e.x, sc.cy - e.y);
        let err_after = (dx * dx + dy * dy).sqrt() / sc.range();
        // Is the truth inside the 95% ellipse of the particle cloud?
        let det = e.cxx * e.cyy - e.cxy * e.cxy;
        let m2 = (e.cyy * dx * dx - 2.0 * e.cxy * dx * dy + e.cxx * dy * dy) / det;
        counted += 1;
        if m2 < 5.991 { inside += 1; }
        if err_before.is_finite() { before.push(err_before); }
        after.push(err_after);
    }
    let med = |v: &mut Vec<f64>| { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v[v.len() / 2] };
    let p90 = |v: &Vec<f64>| v[(v.len() as f64 * 0.9) as usize];
    let (mb, ma) = (med(&mut before), med(&mut after));
    println!("runs tracked: {} of 100", counted);
    println!("median position error before first turn: {:.1}% of range", 100.0 * mb);
    println!("median position error at end: {:.1}% of range (90th pct {:.1}%)", 100.0 * ma, 100.0 * p90(&after));
    println!("truth inside the 95% ellipse: {} of {}", inside, counted);
    assert!(ma < mb, "turning must improve the estimate");
    assert!(ma < 0.15);
    assert!(inside as f64 / counted as f64 > 0.7);
}

#[test]
fn every_physics_constant_is_cited_or_marked_fictional() {
    let src = include_str!("lib.rs");
    let sources = include_str!("../../SOURCES.md");
    let mut prev_doc = String::new();
    for line in src.lines() {
        let t = line.trim();
        if t.starts_with("///") { prev_doc.push_str(t); continue; }
        if t.starts_with("pub const") && t.contains("f64") {
            let ok = prev_doc.contains("FICTIONAL") || prev_doc.contains("[SRC:") || t.contains("DT") ;
            let layout = ["MAX_RANGE", "RAY_STEP"].iter().any(|n| t.contains(n));
            assert!(ok || layout, "uncited constant: {}", t);
            if let Some(i) = prev_doc.find("[SRC: ") {
                let key = &prev_doc[i + 6..prev_doc[i..].find(']').unwrap() + i];
                assert!(sources.contains(&format!("`{}`", key)), "SOURCES.md lacks {}", key);
            }
        }
        prev_doc.clear();
    }
}
