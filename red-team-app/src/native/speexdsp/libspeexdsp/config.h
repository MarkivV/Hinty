/* Minimal config.h for the vendored speexdsp build inside Hinty's native
 * addon. We build just the echo canceller (MDF) and preprocessor (noise
 * suppression). No fixed-point, no external FFT libraries — KissFFT is
 * bundled and handles everything we need at real-time speech rates.
 */

#ifndef HINTY_SPEEXDSP_CONFIG_H
#define HINTY_SPEEXDSP_CONFIG_H

/* Use 32-bit float samples throughout. Modern CPUs make this free. */
#define FLOATING_POINT 1

/* Bundle KissFFT instead of linking external FFT libraries (no fftw3,
 * no Intel MKL / IPP). KissFFT is small, self-contained, and accurate
 * enough for speech-rate AEC. */
#define USE_KISS_FFT 1

/* We embed speexdsp directly as C source, not as a shared library —
 * no symbol visibility decorations needed. */
#define EXPORT

/* Prefix every internal speexdsp symbol so it can't collide with any
 * other speexdsp copy that might end up in the process (e.g. a future
 * dependency that pulls in libspeex). Keeps the ABI private. */
#define RANDOM_PREFIX hinty_speex

/* Platform headers — the vendored code uses `#include "config.h"` which
 * resolves to this file; inttypes / stdint come from the toolchain. */
#define HAVE_STDINT_H 1

#endif /* HINTY_SPEEXDSP_CONFIG_H */
