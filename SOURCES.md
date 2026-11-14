# Sources

Every formula and constant in `sim-core` comes from one of the public sources
below, or is an invented game value marked `FICTIONAL` in the code. A unit test
(`every_physics_constant_is_cited_or_marked_fictional`) fails the build if a
physics constant has neither.

Citations were written from memory and still need checking against the
originals before launch.

| Key | Used for | Source |
| --- | --- | --- |
| `munk-profile` | Sound speed versus depth; constants 1500 m/s, 1300 m, 0.00737; 5000 m test depth | W. H. Munk, "Sound channel in an exponentially stratified ocean, with application to SOFAR", J. Acoust. Soc. Am. 55 (1974). Also the standard Munk test case in Jensen et al. |
| `ray-equations` | Ray equations in range and depth, Snell's law, reflection at boundaries | F. B. Jensen, W. A. Kuperman, M. B. Porter, H. Schmidt, *Computational Ocean Acoustics*, 2nd ed., Springer (2011), chapter 3 |
| `thorp` | Absorption of sound in seawater | Thorp's formula as given in R. J. Urick, *Principles of Underwater Sound*, 3rd ed. (1983) |
| `sonar-equation` | Passive sonar equation; spherical then cylindrical spreading | R. J. Urick, *Principles of Underwater Sound*, 3rd ed. (1983) |
| `particle-filter` | Bootstrap particle filter, systematic resampling, effective sample size | N. J. Gordon, D. J. Salmond, A. F. M. Smith, IEE Proceedings F 140 (1993); M. S. Arulampalam, S. Maskell, N. Gordon, T. Clapp, IEEE Trans. Signal Processing 50 (2002) |
| `bearings-only` | Why range cannot be found from bearings until the observer manoeuvres | V. J. Aidala, S. E. Hammel, IEEE Trans. Automatic Control 28 (1983) |
| `units` | 1 knot = 1852 m per hour | International nautical mile definition |

## Invented values

The contact, its noise level and frequency, the background noise, the array
gain, the path penalties, the detection floor and the mapping from signal
strength to bearing error are all made up for the game. They describe no real
vessel, sensor or procedure.

## Fonts

Source Serif 4 and IBM Plex Mono, both under the SIL Open Font License,
loaded from Google Fonts. Licenses to be confirmed before launch.
