/**
 * panel_helper.mm — Native macOS addon that converts an Electron BrowserWindow
 * into a non-activating floating panel (like NSPanel).
 *
 * Solves:
 *   1. Clicking/dragging the panel does NOT activate the app
 *   2. The panel hides during Mission Control / Exposé
 *   3. Text input works when needed (toggleable key window)
 */

#include <napi.h>
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import <objc/message.h>

// ── Global flag: when YES, the window can become key (for text input) ──
static BOOL gAllowBecomeKey = NO;

// Associated-object key used to stash the pre-swizzle class so we can restore
// it before the NSWindow is deallocated (otherwise AppKit dispatches -dealloc
// through our dynamic subclass, and any teardown path that touches super can
// crash — this is the common source of SIGSEGV-on-quit).
static const char kHintyOriginalClassKey = 0;
static const char kHintyViewOriginalClassKey = 0;

/**
 * Handler for NSWindowWillCloseNotification — restores the original class
 * on both the window and its content view before AppKit tears them down.
 */
@interface HintyPanelCleanupObserver : NSObject
+ (instancetype)sharedObserver;
- (void)windowWillClose:(NSNotification*)note;
@end

@implementation HintyPanelCleanupObserver
+ (instancetype)sharedObserver {
    static HintyPanelCleanupObserver* inst = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ inst = [[HintyPanelCleanupObserver alloc] init]; });
    return inst;
}
- (void)windowWillClose:(NSNotification*)note {
    NSWindow* window = (NSWindow*)[note object];
    if (!window) return;

    // Restore content view's original class
    NSView* contentView = [window contentView];
    if (contentView) {
        id origViewClassObj = objc_getAssociatedObject(contentView, &kHintyViewOriginalClassKey);
        if (origViewClassObj) {
            Class origViewClass = (__bridge Class)(void*)[origViewClassObj pointerValue];
            if (origViewClass) {
                object_setClass(contentView, origViewClass);
            }
            objc_setAssociatedObject(contentView, &kHintyViewOriginalClassKey, nil, OBJC_ASSOCIATION_RETAIN);
        }
    }

    // Restore window's original class
    id origClassObj = objc_getAssociatedObject(window, &kHintyOriginalClassKey);
    if (origClassObj) {
        Class origClass = (__bridge Class)(void*)[origClassObj pointerValue];
        if (origClass) {
            object_setClass(window, origClass);
        }
        objc_setAssociatedObject(window, &kHintyOriginalClassKey, nil, OBJC_ASSOCIATION_RETAIN);
    }

    [[NSNotificationCenter defaultCenter] removeObserver:self
                                                    name:NSWindowWillCloseNotification
                                                  object:window];
}
@end

// ── Method implementations for our dynamic subclass ──

// The critical override: macOS checks this internally in [NSApp sendEvent:]
// to decide whether clicking a window should activate the owning app.
static BOOL panel_isNonactivatingPanel(id self, SEL _cmd) {
    return YES;
}

static BOOL panel_canBecomeKey(id self, SEL _cmd) {
    return gAllowBecomeKey;
}

static BOOL panel_canBecomeMain(id self, SEL _cmd) {
    return NO;
}

static BOOL panel_isFloatingPanel(id self, SEL _cmd) {
    return YES;
}

static BOOL panel_hidesOnDeactivate(id self, SEL _cmd) {
    return NO;
}

// Override sendEvent: to prevent app activation on ALL mouse events,
// including drag operations triggered by -webkit-app-region: drag.
static void panel_sendEvent(id self, SEL _cmd, NSEvent* event) {
    NSEventType type = [event type];
    if (type == NSEventTypeLeftMouseDown ||
        type == NSEventTypeRightMouseDown ||
        type == NSEventTypeOtherMouseDown) {
        [NSApp preventWindowOrdering];
    }
    // Call super
    struct objc_super superInfo;
    superInfo.receiver = self;
    superInfo.super_class = class_getSuperclass(object_getClass(self));
    ((void (*)(struct objc_super*, SEL, NSEvent*))objc_msgSendSuper)(&superInfo, _cmd, event);
}

// Accept first mouse so clicks register immediately without activation
static BOOL panel_acceptsFirstMouse(id self, SEL _cmd, NSEvent* event) {
    return YES;
}

// ── N-API bindings ──

Napi::Value MakePanel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Expected a Buffer (getNativeWindowHandle)")
            .ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
    NSView* contentView = *reinterpret_cast<NSView**>(buf.Data());
    if (!contentView) return Napi::Boolean::New(env, false);

    NSWindow* window = [contentView window];
    if (!window) return Napi::Boolean::New(env, false);

    // 1. Collection behavior:
    //    - CanJoinAllSpaces: visible on all desktops
    //    - Transient: hides during Mission Control / Exposé
    //    - IgnoresCycle: skip in Cmd+` window cycling
    //    - FullScreenAuxiliary: can appear over fullscreen apps
    [window setCollectionBehavior:
        NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorTransient |
        NSWindowCollectionBehaviorFullScreenAuxiliary |
        NSWindowCollectionBehaviorIgnoresCycle];

    // 2. Create a dynamic subclass (isa-swizzle)
    const char* subclassName = "HintyFloatingPanel";
    Class subclass = objc_getClass(subclassName);

    Class originalWindowClass = object_getClass(window);
    if (!subclass) {
        subclass = objc_allocateClassPair(originalWindowClass, subclassName, 0);
        if (!subclass) return Napi::Boolean::New(env, false);

        // _isNonactivatingPanel — prevents app activation on click
        class_addMethod(subclass, NSSelectorFromString(@"_isNonactivatingPanel"),
                        (IMP)panel_isNonactivatingPanel, "B@:");

        class_addMethod(subclass, @selector(isFloatingPanel),
                        (IMP)panel_isFloatingPanel, "B@:");

        class_addMethod(subclass, @selector(hidesOnDeactivate),
                        (IMP)panel_hidesOnDeactivate, "B@:");

        class_addMethod(subclass, @selector(canBecomeKey),
                        (IMP)panel_canBecomeKey, "B@:");

        class_addMethod(subclass, @selector(canBecomeMain),
                        (IMP)panel_canBecomeMain, "B@:");

        // sendEvent: — catches ALL mouse events including drags
        class_addMethod(subclass, @selector(sendEvent:),
                        (IMP)panel_sendEvent, "v@:@");

        objc_registerClassPair(subclass);
    }

    // Stash original window class so we can restore before dealloc.
    objc_setAssociatedObject(window, &kHintyOriginalClassKey,
        [NSValue valueWithPointer:(__bridge void*)originalWindowClass],
        OBJC_ASSOCIATION_RETAIN_NONATOMIC);

    object_setClass(window, subclass);

    // 3. Override acceptsFirstMouse on the content view
    const char* viewSubclassName = "HintyPanelContentView";
    Class viewSubclass = objc_getClass(viewSubclassName);
    Class viewOriginalClass = object_getClass(contentView);

    if (!viewSubclass) {
        viewSubclass = objc_allocateClassPair(viewOriginalClass, viewSubclassName, 0);
        if (viewSubclass) {
            class_addMethod(viewSubclass, @selector(acceptsFirstMouse:),
                            (IMP)panel_acceptsFirstMouse, "B@:@");
            objc_registerClassPair(viewSubclass);
        }
    }

    if (viewSubclass) {
        objc_setAssociatedObject(contentView, &kHintyViewOriginalClassKey,
            [NSValue valueWithPointer:(__bridge void*)viewOriginalClass],
            OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        object_setClass(contentView, viewSubclass);
    }

    // 4. Floating window level
    [window setLevel:NSFloatingWindowLevel];

    // 5. Register willClose observer so we can un-swizzle before dealloc.
    //    Without this, the NSWindow gets deallocated while still pointing at
    //    our dynamic subclass, and AppKit's teardown path can SIGSEGV.
    [[NSNotificationCenter defaultCenter]
        addObserver:[HintyPanelCleanupObserver sharedObserver]
           selector:@selector(windowWillClose:)
               name:NSWindowWillCloseNotification
             object:window];

    return Napi::Boolean::New(env, true);
}

/**
 * setAllowKeyWindow(allow, handle?) → void
 *
 * allow=true:  panel can become key + immediately makes it key (for typing)
 * allow=false: panel resigns key window cleanly (no blur/hide side effects)
 */
Napi::Value SetAllowKeyWindow(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBoolean()) {
        return env.Undefined();
    }

    gAllowBecomeKey = info[0].As<Napi::Boolean>().Value();

    if (info.Length() >= 2 && info[1].IsBuffer()) {
        Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();
        // Wrap in @try/@catch — the NSView pointer stored in the Buffer can
        // become dangling if the window was destroyed between the JS-side
        // isDestroyed() check and this native call (teardown race).
        @try {
            NSView* view = *reinterpret_cast<NSView**>(buf.Data());
            if (view) {
                NSWindow* window = [view window];
                // Verify the window is still alive and managed by NSApp
                if (window && [[NSApp windows] containsObject:window]) {
                    if (gAllowBecomeKey) {
                        [window makeKeyWindow];
                    } else {
                        [window resignKeyWindow];
                    }
                }
            }
        } @catch (NSException* e) {
            NSLog(@"[panel_helper] setAllowKeyWindow ignored stale handle: %@", e);
        }
    }

    return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("makePanel", Napi::Function::New(env, MakePanel));
    exports.Set("setAllowKeyWindow", Napi::Function::New(env, SetAllowKeyWindow));
    return exports;
}

NODE_API_MODULE(panel_helper, Init)
