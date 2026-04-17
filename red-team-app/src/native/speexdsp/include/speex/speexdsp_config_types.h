/* speexdsp integer type config — normally generated at configure time
 * from speexdsp_config_types.h.in. For our embedded build we just use
 * the standard <stdint.h> types directly, which are available on every
 * modern macOS / Linux / Windows toolchain. */

#ifndef __SPEEX_TYPES_H__
#define __SPEEX_TYPES_H__

#include <stdint.h>

typedef int16_t  spx_int16_t;
typedef uint16_t spx_uint16_t;
typedef int32_t  spx_int32_t;
typedef uint32_t spx_uint32_t;

#endif
