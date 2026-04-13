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
    }
  ]
}
