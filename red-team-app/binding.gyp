{
  "targets": [
    {
      "target_name": "panel_helper",
      "sources": ["src/native/panel_helper.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "OTHER_CPLUSPLUSFLAGS": ["-ObjC++", "-std=c++17"],
            "OTHER_LDFLAGS": ["-framework Cocoa"]
          }
        }]
      ]
    },
    {
      "target_name": "audio_capture",
      "sources": [
        "src/native/audio_capture.mm",
        "src/native/speexdsp/libspeexdsp/mdf.c",
        "src/native/speexdsp/libspeexdsp/preprocess.c",
        "src/native/speexdsp/libspeexdsp/fftwrap.c",
        "src/native/speexdsp/libspeexdsp/kiss_fft.c",
        "src/native/speexdsp/libspeexdsp/kiss_fftr.c",
        "src/native/speexdsp/libspeexdsp/filterbank.c",
        "src/native/speexdsp/libspeexdsp/smallft.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src/native/speexdsp/include",
        "src/native/speexdsp/libspeexdsp"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "HAVE_CONFIG_H"
      ],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "OTHER_CPLUSPLUSFLAGS": ["-ObjC++", "-std=c++17"],
            "OTHER_CFLAGS": [
              "-std=gnu99",
              "-Wno-unused-function",
              "-Wno-unused-variable",
              "-Wno-unused-but-set-variable",
              "-Wno-sign-compare",
              "-Wno-implicit-function-declaration"
            ],
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "OTHER_LDFLAGS": [
              "-framework ScreenCaptureKit",
              "-framework CoreMedia",
              "-framework AVFoundation",
              "-framework AudioToolbox",
              "-framework Cocoa"
            ]
          }
        }]
      ]
    }
  ]
}
