# Sources

Every formula and constant in `sim-core` comes from one of the public sources
below, or is an invented game value marked `FICTIONAL` in the code. A unit test
(`every_physics_constant_is_cited_or_marked_fictional`) fails the build if a
physics constant has neither.

| Key | Used for | Source | Checked |
| --- | --- | --- | --- |
| `munk-profile` | Sound speed versus depth; constants 1500 m/s, 1300 m, 0.00737; 5000 m test depth | W. H. Munk, "Sound channel in an exponentially stratified ocean, with application to SOFAR", J. Acoust. Soc. Am. 55, 220-226 (1974) | Citation checked online. The constants reproduce the published BELLHOP Munk test profile (1548.52 m/s at the surface, 1530.29 at 200 m, 1551.91 at 5000 m). |
| `ray-equations` | Ray equations in range and depth, Snell's law, reflection at boundaries | F. B. Jensen, W. A. Kuperman, M. B. Porter, H. Schmidt, *Computational Ocean Acoustics*, 2nd ed., Springer (2011), chapter 3 | Book not opened; the implementation is checked numerically against BELLHOP instead (below). |
| `thorp` | Absorption of sound in seawater | Thorp's formula as given in R. J. Urick, *Principles of Underwater Sound*, 3rd ed. (1983) | Coefficients (0.11, 44, 2.75e-4, 0.003, in dB/km with frequency in kHz) checked online against other users of the formula. Book not opened. |
| `sonar-equation` | Passive sonar equation; spherical then cylindrical spreading | R. J. Urick, *Principles of Underwater Sound*, 3rd ed. (1983) | Book not opened. |
| `particle-filter` | Bootstrap particle filter, systematic resampling, effective sample size, regularised resampling | N. J. Gordon, D. J. Salmond, A. F. M. Smith, "Novel approach to nonlinear/non-Gaussian Bayesian state estimation", IEE Proceedings F 140(2), 107-113 (1993); M. S. Arulampalam, S. Maskell, N. Gordon, T. Clapp, "A tutorial on particle filters for online nonlinear/non-Gaussian Bayesian tracking", IEEE Trans. Signal Processing 50(2), 174-188 (2002) | Both citations checked online. |
| `bearings-only` | Why range cannot be found from bearings until the observer manoeuvres | V. J. Aidala, S. E. Hammel, "Utilization of modified polar coordinates for bearings-only tracking", IEEE Trans. Automatic Control 28(3), 283-294 (1983) | Citation checked online. |
| `units` | 1 knot = 1852 m per hour | International nautical mile definition | Standard definition. |

## Reference model

`sim-core/tests/data/bellhop_munk_rays.csv` holds ray paths computed once by
BELLHOP (M. B. Porter), run through its open-source C++ port, bellhopcxx, from
github.com/A-New-BellHope/bellhopcuda, on the input file
`sim-core/tests/data/munk.env`. The test
`rays_match_the_bellhop_reference_model` compares this project's ray tracer
against them. BELLHOP is licensed under the GPL; only its output data and an
input file written for this project are stored here, and none of its code.

Result at the last build: rays that touch neither boundary agree within 0.2 m
of depth over 100 km; rays that bounce four times agree within 8 m.

## Invented values

The contact, its noise level and frequency, the background noise, the array
gain, the path penalties, the detection floor and the mapping from signal
strength to bearing error are all made up for the game. They describe no real
vessel, sensor or procedure.

## Fonts

Source Serif 4 and IBM Plex Mono, loaded from Google Fonts. Both are published
under the SIL Open Font License; this has not been re-checked against the font
repositories.
