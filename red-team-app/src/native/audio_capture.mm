/**
 * audio_capture.mm — Native macOS addon for capturing system audio + microphone
 * using ScreenCaptureKit (macOS 13+) and AVAudioEngine.
 *
 * Exports:
 *   checkPermission()        → 'granted' | 'denied' | 'unknown'
 *   requestPermission()      → Promise<boolean>
 *   startCapture(callback)   → boolean  (callback receives PCM Buffer chunks)
 *   stopCapture()            → void
 *   isCapturing()            → boolean
 *
 * Audio output:
 *   Stereo 16-bit PCM @ 16kHz
 *   Left channel  = system audio (other meeting participants)
 *   Right channel = microphone (you)
 */

#include <napi.h>
#include <cmath>
#include <algorithm>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#include <vector>
#include <mutex>
#include <atomic>

extern "C" {
#include "speex/speex_echo.h"
#include "speex/speex_preprocess.h"
}

// ── Constants ──
static const double kTargetSampleRate = 16000.0;
// Stereo output: L=system, R=mic
static const int kChunkDurationMs = 100; // send chunks every 100ms
static const int kSamplesPerChunk = (int)(kTargetSampleRate * kChunkDurationMs / 1000.0);

// ── State ──
static std::atomic<bool> gIsCapturing{false};
static Napi::ThreadSafeFunction gTsfn;

// ── Speex acoustic echo canceller + preprocessor ──
//
// Production-grade AEC from Xiph.Org's speexdsp library (BSD-licensed,
// vendored in src/native/speexdsp/). Uses the Multi-Delay Block Frequency
// Adaptive Filter (MDF) algorithm — the same family as WebRTC AEC3 — in
// frequency-domain blocks with built-in:
//
//   - adaptive step size (no manual DTD tuning needed)
//   - leak factor
//   - residual echo suppressor (knocks out what linear AEC misses)
//
// Chained with the Speex preprocessor for noise suppression so background
// hum / keyboard / fan noise doesn't show up in "You".
//
// Frame size must be a power of 2 and match what we feed per call. We use
// 160 samples = 10ms at 16kHz, matching common VoIP frame sizes. Filter
// length = 16 * frame_size = 160ms, plenty for laptop acoustic paths.
class SpeexEchoCanceller {
public:
    static constexpr int kSampleRate = 16000;   // matches kTargetSampleRate
    // Power-of-2 sizes — Speex's MDF uses FFT blocks of (2 * frame_size)
    // and converges much more reliably when that's a clean power of 2.
    // Speex's own testecho.c uses 128/1024 at 8kHz, which is equivalent.
    static constexpr int kFrameSize = 256;      // 16ms @ 16kHz, 2^8
    // 128ms filter — plenty for digital loopback echo paths (delay
    // typically under 50ms) and the small-room acoustic echo we'd see
    // from a laptop on a desk. Shorter = faster convergence.
    static constexpr int kFilterLength = 2048;  // 128ms @ 16kHz, 2^11

    SpeexEchoCanceller() : echoState(nullptr), preprocState(nullptr),
                            diagFrameCount(0), diagMicE(0), diagRefE(0), diagOutE(0) {}
    ~SpeexEchoCanceller() { destroy(); }

    void reset() {
        destroy();
        diagFrameCount = 0;
        diagMicE = 0;
        diagRefE = 0;
        diagOutE = 0;

        echoState = speex_echo_state_init(kFrameSize, kFilterLength);
        if (echoState) {
            int rate = kSampleRate;
            speex_echo_ctl(echoState, SPEEX_ECHO_SET_SAMPLING_RATE, &rate);
            NSLog(@"[aec] Speex echo canceller initialized: frame=%d filter=%d rate=%d",
                  kFrameSize, kFilterLength, rate);
        } else {
            NSLog(@"[aec] ERROR: speex_echo_state_init returned NULL");
        }

        preprocState = speex_preprocess_state_init(kFrameSize, kSampleRate);
        if (preprocState) {
            // Associate preprocessor with echo canceller — Speex uses this
            // to coordinate their state. The preprocessor's residual
            // echo suppressor reads the AEC's internal echo estimate
            // and attenuates the output accordingly, catching echo that
            // MDF couldn't fully cancel.
            speex_preprocess_ctl(preprocState, SPEEX_PREPROCESS_SET_ECHO_STATE, echoState);

            int denoise = 1;
            speex_preprocess_ctl(preprocState, SPEEX_PREPROCESS_SET_DENOISE, &denoise);

            // Aggressive residual echo suppression. Defaults are -40dB
            // (no near-end speech) and -15dB (near-end active). We push
            // both substantially — the linear MDF struggles with digital
            // loopback at the high mic-to-ref ratio we see (~-8dB echo
            // path), so we let the residual suppressor do the heavy
            // lifting. Risk: over-suppression can briefly mute the
            // user's voice when they talk over the participant. For
            // meeting transcription that's acceptable; for real-time
            // VoIP it would not be.
            int echoSuppress = -60;
            speex_preprocess_ctl(preprocState, SPEEX_PREPROCESS_SET_ECHO_SUPPRESS, &echoSuppress);
            int echoSuppressActive = -40;
            speex_preprocess_ctl(preprocState, SPEEX_PREPROCESS_SET_ECHO_SUPPRESS_ACTIVE, &echoSuppressActive);

            // No auto-gain control — we don't want Speex boosting the mic,
            // since that would also amplify any residual echo. Deepgram
            // handles level variation fine.
            int agc = 0;
            speex_preprocess_ctl(preprocState, SPEEX_PREPROCESS_SET_AGC, &agc);

            // Voice activity detection off — we rely on Deepgram's VAD.
            int vad = 0;
            speex_preprocess_ctl(preprocState, SPEEX_PREPROCESS_SET_VAD, &vad);
        }
    }

    // Process one frame (kFrameSize float samples). Converts to int16 for
    // Speex, cancels echo, runs noise suppression, returns cleaned floats.
    void processFrame(const float* mic, const float* ref, float* out) {
        spx_int16_t micInt[kFrameSize];
        spx_int16_t refInt[kFrameSize];
        spx_int16_t outInt[kFrameSize];

        for (int i = 0; i < kFrameSize; i++) {
            micInt[i] = (spx_int16_t)std::max(-32768.0f, std::min(32767.0f, mic[i] * 32767.0f));
            refInt[i] = (spx_int16_t)std::max(-32768.0f, std::min(32767.0f, ref[i] * 32767.0f));
        }

        if (echoState) {
            speex_echo_cancellation(echoState, micInt, refInt, outInt);
        } else {
            memcpy(outInt, micInt, sizeof(outInt));
        }

        // Preprocessor runs AFTER AEC and applies noise suppression +
        // residual echo suppression (via the shared echo state). This is
        // what gives the final 10-20dB of cleanup on top of the filter.
        if (preprocState) {
            speex_preprocess_run(preprocState, outInt);
        }

        constexpr float kInv = 1.0f / 32768.0f;
        for (int i = 0; i < kFrameSize; i++) {
            out[i] = (float)outInt[i] * kInv;
        }

        // ── Diagnostic: aggregate energy over the full 1s window so
        // single quiet frames don't skew the ratio.
        for (int i = 0; i < kFrameSize; i++) {
            diagMicE += (double)mic[i] * mic[i];
            diagRefE += (double)ref[i] * ref[i];
            diagOutE += (double)out[i] * out[i];
        }
        diagFrameCount++;
        const int kDiagInterval = 100; // 100 frames × 10ms = 1s
        if (diagFrameCount >= kDiagInterval) {
            const int totalSamples = kDiagInterval * kFrameSize;
            const float micRms = std::sqrt(diagMicE / totalSamples);
            const float refRms = std::sqrt(diagRefE / totalSamples);
            const float outRms = std::sqrt(diagOutE / totalSamples);
            NSLog(@"[aec] mic=%.4f ref=%.4f clean=%.4f attenuation=%.1fdB state=%s",
                  micRms, refRms, outRms,
                  (micRms > 1e-6f) ? 20.0f * std::log10(outRms / micRms) : 0.0f,
                  echoState ? "ok" : "null");
            diagFrameCount = 0;
            diagMicE = 0; diagRefE = 0; diagOutE = 0;
        }
    }

private:
    void destroy() {
        if (preprocState) { speex_preprocess_state_destroy(preprocState); preprocState = nullptr; }
        if (echoState) { speex_echo_state_destroy(echoState); echoState = nullptr; }
    }

    SpeexEchoState* echoState;
    SpeexPreprocessState* preprocState;
    int diagFrameCount;
    double diagMicE;
    double diagRefE;
    double diagOutE;
};

static SpeexEchoCanceller gEchoCanceller;

// System audio capture
static SCStream* gStream API_AVAILABLE(macos(13.0)) = nil;
static id<SCStreamDelegate> gStreamDelegate API_AVAILABLE(macos(13.0)) = nil;
static id<SCStreamOutput> gStreamOutput API_AVAILABLE(macos(13.0)) = nil;

// Microphone capture
static AVAudioEngine* gAudioEngine = nil;

// Buffers (protected by mutex)
static std::mutex gBufferMutex;
static std::vector<float> gSystemBuffer;  // accumulated system audio samples (mono, 16kHz)
static std::vector<float> gMicBuffer;     // accumulated mic audio samples (mono, 16kHz)

// ── Audio format conversion helpers ──

/**
 * Simple linear resampler: converts from srcRate to dstRate (mono).
 * Uses linear interpolation — good enough for speech.
 */
static std::vector<float> resample(const float* src, size_t srcFrames, double srcRate, double dstRate) {
    if (srcFrames == 0) return {};
    double ratio = srcRate / dstRate;
    size_t dstFrames = (size_t)(srcFrames / ratio);
    if (dstFrames == 0) return {};

    std::vector<float> dst(dstFrames);
    for (size_t i = 0; i < dstFrames; i++) {
        double srcPos = i * ratio;
        size_t idx = (size_t)srcPos;
        double frac = srcPos - idx;
        if (idx + 1 < srcFrames) {
            dst[i] = (float)(src[idx] * (1.0 - frac) + src[idx + 1] * frac);
        } else {
            dst[i] = src[std::min(idx, srcFrames - 1)];
        }
    }
    return dst;
}

/**
 * Downmix interleaved multi-channel audio to mono.
 */
static std::vector<float> downmixToMono(const float* src, size_t frames, int channels) {
    if (channels == 1) {
        return std::vector<float>(src, src + frames);
    }
    std::vector<float> mono(frames);
    for (size_t i = 0; i < frames; i++) {
        float sum = 0;
        for (int ch = 0; ch < channels; ch++) {
            sum += src[i * channels + ch];
        }
        mono[i] = sum / channels;
    }
    return mono;
}

/**
 * Send interleaved stereo 16-bit PCM chunk to JS via ThreadSafeFunction.
 */
static void sendChunkToJS() {
    std::vector<float> sysSamples, micSamples;

    {
        std::lock_guard<std::mutex> lock(gBufferMutex);

        // Only emit a chunk when BOTH buffers have at least kSamplesPerChunk
        // samples ready. This preserves each channel's internal continuity —
        // no silence gets injected mid-stream (which would make Deepgram
        // think speech ended and drop words).
        //
        // NOTE: we do NOT equalize buffer sizes between the two streams.
        // Deepgram multichannel processes each channel independently, so a
        // constant time offset between L and R doesn't hurt transcription.
        // Equalizing would mean throwing away real audio from the faster
        // stream (typically system audio, since AEC adds latency to mic).
        if (gSystemBuffer.size() < (size_t)kSamplesPerChunk ||
            gMicBuffer.size()    < (size_t)kSamplesPerChunk) {
            return;
        }

        // Only drop audio if a buffer grows pathologically large (e.g., a
        // capture thread stalled). Cap at 2 seconds — well above normal
        // jitter, so we never discard real speech in steady state.
        const size_t kMaxBuffered = (size_t)kSamplesPerChunk * 20; // 2000ms
        if (gSystemBuffer.size() > kMaxBuffered) {
            gSystemBuffer.erase(gSystemBuffer.begin(),
                                gSystemBuffer.begin() + (gSystemBuffer.size() - kMaxBuffered));
        }
        if (gMicBuffer.size() > kMaxBuffered) {
            gMicBuffer.erase(gMicBuffer.begin(),
                             gMicBuffer.begin() + (gMicBuffer.size() - kMaxBuffered));
        }

        sysSamples.assign(gSystemBuffer.begin(), gSystemBuffer.begin() + kSamplesPerChunk);
        gSystemBuffer.erase(gSystemBuffer.begin(), gSystemBuffer.begin() + kSamplesPerChunk);

        micSamples.assign(gMicBuffer.begin(), gMicBuffer.begin() + kSamplesPerChunk);
        gMicBuffer.erase(gMicBuffer.begin(), gMicBuffer.begin() + kSamplesPerChunk);
    }

    const size_t frames = (size_t)kSamplesPerChunk;

    // ── Acoustic echo cancellation (Speex MDF + noise suppression) ──
    // Iterate Speex frames across our 100ms chunk. Each call updates the
    // canceller's internal filter state, and the preprocessor (chained
    // via SPEEX_PREPROCESS_SET_ECHO_STATE) does the residual suppression.
    std::vector<float> cleanedMic(frames);
    constexpr size_t kSpeexFrame = SpeexEchoCanceller::kFrameSize; // 256
    for (size_t off = 0; off + kSpeexFrame <= frames; off += kSpeexFrame) {
        gEchoCanceller.processFrame(&micSamples[off], &sysSamples[off], &cleanedMic[off]);
    }

    // ── Near-end activity gate ──
    //
    // Speex AEC + preprocessor does its best, but even -12dB residual is
    // still loud enough for Deepgram to transcribe. So on top of AEC we
    // apply a deterministic rule: if the reference (participant audio)
    // has meaningful energy in this window, the user's mic output is
    // silenced for this window — effectively saying "only one party is
    // the active speaker at any given moment, and right now it's Them."
    //
    // This is how every serious meeting-transcription product handles
    // the echo problem. The only cost is that if the user starts
    // speaking while the participant is mid-sentence, the first ~100ms
    // of the user's voice may be clipped until the participant pauses.
    // For meeting summarization that's imperceptible; Deepgram's
    // contextual decoding fills any short gaps in the transcript.
    double refEnergy = 0.0;
    for (size_t i = 0; i < frames; i++) {
        refEnergy += (double)sysSamples[i] * sysSamples[i];
    }
    const double refRms = std::sqrt(refEnergy / frames);

    // Threshold chosen from production logs — participant speech
    // consistently shows ref RMS of 0.02+, while ambient bleed from
    // system noise sits at or below 0.001. 0.0025 is comfortably in
    // the gap: any real speech trips the gate; pure silence does not.
    constexpr double kRefActiveThreshold = 0.0025;
    const bool gatedOut = (refRms > kRefActiveThreshold);
    if (gatedOut) {
        std::fill(cleanedMic.begin(), cleanedMic.end(), 0.0f);
    }

    // Once-a-second log of the gate's decision so we can confirm it's
    // tracking participant speech correctly.
    static int gateLogCounter = 0;
    gateLogCounter++;
    if (gateLogCounter >= 10) {  // every ~1s (10 × 100ms chunks)
        gateLogCounter = 0;
        NSLog(@"[gate] refRms=%.4f gated=%s", refRms, gatedOut ? "YES (mic muted)" : "no");
    }

    // Interleave as stereo 16-bit PCM: [L0, R0, L1, R1, ...]
    // L = system (Them), R = cleaned mic (You).
    std::vector<int16_t> pcm(frames * 2);
    for (size_t i = 0; i < frames; i++) {
        float sysVal = std::max(-1.0f, std::min(1.0f, sysSamples[i]));
        float micVal = std::max(-1.0f, std::min(1.0f, cleanedMic[i]));
        pcm[i * 2]     = (int16_t)(sysVal * 32767.0f);
        pcm[i * 2 + 1] = (int16_t)(micVal * 32767.0f);
    }

    // Copy to a shared buffer for the callback
    auto* dataCopy = new std::vector<int16_t>(std::move(pcm));

    gTsfn.NonBlockingCall(dataCopy, [](Napi::Env env, Napi::Function jsCallback, std::vector<int16_t>* data) {
        size_t byteLen = data->size() * sizeof(int16_t);
        auto buf = Napi::Buffer<uint8_t>::Copy(env, reinterpret_cast<uint8_t*>(data->data()), byteLen);
        jsCallback.Call({buf});
        delete data;
    });
}

// ── Timer to flush buffers periodically ──
static dispatch_source_t gFlushTimer = nil;

static void startFlushTimer() {
    if (gFlushTimer) return;
    gFlushTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                         dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_HIGH, 0));
    uint64_t interval = kChunkDurationMs * NSEC_PER_MSEC;
    dispatch_source_set_timer(gFlushTimer, dispatch_time(DISPATCH_TIME_NOW, interval), interval, interval / 10);
    dispatch_source_set_event_handler(gFlushTimer, ^{
        if (gIsCapturing) {
            sendChunkToJS();
        }
    });
    dispatch_resume(gFlushTimer);
}

static void stopFlushTimer() {
    if (gFlushTimer) {
        dispatch_source_cancel(gFlushTimer);
        gFlushTimer = nil;
    }
}

// ── SCStream delegate & output handler (system audio + microphone) ──

API_AVAILABLE(macos(13.0))
@interface HintyStreamDelegate : NSObject <SCStreamDelegate, SCStreamOutput>
@end

/**
 * Decode a CMSampleBuffer into an interleaved mono float vector at its
 * native sample rate. Returns the native sample rate via `outRate`.
 * Handles both planar (non-interleaved) and interleaved formats — SCK
 * system audio is typically planar; mic audio via SCK is typically
 * interleaved, but we don't hard-code assumptions.
 */
static std::vector<float> decodeSampleBufferToMono(CMSampleBufferRef sampleBuffer, double* outRate) {
    std::vector<float> mono;
    *outRate = kTargetSampleRate;

    CMFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
    if (!formatDesc) return mono;

    const AudioStreamBasicDescription* asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
    if (!asbd) return mono;

    int channels = (int)asbd->mChannelsPerFrame;
    *outRate = asbd->mSampleRate;
    bool isNonInterleaved = (asbd->mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;

    size_t bufferListSize = sizeof(AudioBufferList) + sizeof(AudioBuffer) * (channels - 1);
    AudioBufferList* bufferList = (AudioBufferList*)malloc(bufferListSize);
    if (!bufferList) return mono;

    CMBlockBufferRef retainedBlockBuffer = NULL;
    OSStatus status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        NULL,
        bufferList,
        bufferListSize,
        NULL, NULL,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        &retainedBlockBuffer);

    if (status != noErr || bufferList->mNumberBuffers == 0) {
        free(bufferList);
        if (retainedBlockBuffer) CFRelease(retainedBlockBuffer);
        return mono;
    }

    if (isNonInterleaved) {
        size_t frames = bufferList->mBuffers[0].mDataByteSize / sizeof(float);
        mono.resize(frames, 0.0f);
        UInt32 numCh = std::min((UInt32)channels, bufferList->mNumberBuffers);
        for (UInt32 ch = 0; ch < numCh; ch++) {
            const float* chData = (const float*)bufferList->mBuffers[ch].mData;
            if (!chData) continue;
            for (size_t i = 0; i < frames; i++) mono[i] += chData[i];
        }
        if (numCh > 1) {
            float inv = 1.0f / (float)numCh;
            for (size_t i = 0; i < frames; i++) mono[i] *= inv;
        }
    } else {
        const float* data = (const float*)bufferList->mBuffers[0].mData;
        size_t totalFloats = bufferList->mBuffers[0].mDataByteSize / sizeof(float);
        size_t frames = totalFloats / channels;
        if (data && frames > 0) mono = downmixToMono(data, frames, channels);
    }

    free(bufferList);
    if (retainedBlockBuffer) CFRelease(retainedBlockBuffer);
    return mono;
}

@implementation HintyStreamDelegate

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
        ofType:(SCStreamOutputType)type API_AVAILABLE(macos(13.0)) {
    if (!gIsCapturing) return;

    // Route both system audio (SCStreamOutputTypeAudio) and microphone
    // audio (SCStreamOutputTypeMicrophone on macOS 15+) through one
    // decoder. Everything else (screen frames) is ignored.
    bool isSystem = (type == SCStreamOutputTypeAudio);
    bool isMic = false;
    if (@available(macOS 15.0, *)) {
        isMic = (type == SCStreamOutputTypeMicrophone);
    }
    if (!isSystem && !isMic) return;

    double nativeRate = kTargetSampleRate;
    std::vector<float> mono = decodeSampleBufferToMono(sampleBuffer, &nativeRate);
    if (mono.empty()) return;

    auto resampled = resample(mono.data(), mono.size(), nativeRate, kTargetSampleRate);

    {
        std::lock_guard<std::mutex> lock(gBufferMutex);
        if (isSystem) {
            gSystemBuffer.insert(gSystemBuffer.end(), resampled.begin(), resampled.end());
        } else {
            // SCStreamOutputTypeMicrophone: tap of the default mic, shared with
            // other apps. No exclusivity, no AGC, no AEC — true coexistence.
            gMicBuffer.insert(gMicBuffer.end(), resampled.begin(), resampled.end());
        }
    }
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error API_AVAILABLE(macos(13.0)) {
    NSLog(@"[audio_capture] SCStream stopped with error: %@", error);
    gIsCapturing = false;
}

@end

// ── Microphone capture via AVAudioEngine (macOS < 15 fallback only) ──
//
// On macOS 15+ we capture the mic through ScreenCaptureKit instead (see the
// SCStreamConfiguration.captureMicrophone path in startSystemAudioCapture).
// SCK's mic tap is shared — Meet, Zoom, Discord, Telegram all keep full
// access to the mic because SCK doesn't reserve the audio device the way
// AVAudioEngine's VoiceProcessingIO path does. This fallback only runs on
// older macOS where captureMicrophone isn't available; it uses plain HAL
// input (no voice processing) for the same reason.
static void startMicCaptureFallback() {
    gAudioEngine = [[AVAudioEngine alloc] init];
    AVAudioInputNode* inputNode = [gAudioEngine inputNode];

    AVAudioFormat* inputFormat = [inputNode outputFormatForBus:0];
    double micSampleRate = [inputFormat sampleRate];
    int micChannels = (int)[inputFormat channelCount];

    [inputNode installTapOnBus:0 bufferSize:1600 format:inputFormat
                         block:^(AVAudioPCMBuffer* buffer, AVAudioTime* when) {
        if (!gIsCapturing) return;

        float* const* channelData = [buffer floatChannelData];
        if (!channelData) return;

        UInt32 frameCount = [buffer frameLength];

        std::vector<float> mono(frameCount);
        if (micChannels == 1) {
            memcpy(mono.data(), channelData[0], frameCount * sizeof(float));
        } else {
            for (UInt32 i = 0; i < frameCount; i++) {
                float sum = 0;
                for (int ch = 0; ch < micChannels; ch++) sum += channelData[ch][i];
                mono[i] = sum / micChannels;
            }
        }

        auto resampled = resample(mono.data(), mono.size(), micSampleRate, kTargetSampleRate);
        {
            std::lock_guard<std::mutex> lock(gBufferMutex);
            gMicBuffer.insert(gMicBuffer.end(), resampled.begin(), resampled.end());
        }
    }];

    NSError* error = nil;
    [gAudioEngine startAndReturnError:&error];
    if (error) {
        NSLog(@"[audio_capture] AVAudioEngine start error: %@", error);
    } else {
        NSLog(@"[audio_capture] Microphone capture started via AVAudioEngine fallback (%.0fHz, %d ch)", micSampleRate, micChannels);
    }
}

static void stopMicCaptureFallback() {
    if (gAudioEngine) {
        [[gAudioEngine inputNode] removeTapOnBus:0];
        [gAudioEngine stop];
        gAudioEngine = nil;
        NSLog(@"[audio_capture] AVAudioEngine mic capture stopped");
    }
}

// ── ScreenCaptureKit capture (system audio only) ──
//
// We DO NOT use SCK's captureMicrophone here, even on macOS 15+ where
// that API exists. When SCK captures the mic, the signal it delivers has
// a low-delay electronic mix of system audio bleeding into the mic
// channel at a consistent 2–3× ratio (observed in production logs). That
// near-zero-delay digital mix is not what Speex's MDF algorithm is
// designed to cancel — MDF models acoustic echo paths with meaningful
// delay and spectral coloration.
//
// Instead, we capture the mic through AVAudioEngine's plain input tap
// (no VoiceProcessingIO). That delivers the raw physical microphone
// signal — just what the mic actually heard — which is exactly what
// Speex AEC expects, AND does not reserve the mic HAL from other apps
// the way VPIO does. Meet/Zoom/Discord/Telegram all continue to share
// the mic normally.
static BOOL scStreamShouldCaptureMic() {
    return NO;
}

static void startSystemAudioCapture() API_AVAILABLE(macos(13.0)) {
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                              onScreenWindowsOnly:NO
                                                completionHandler:^(SCShareableContent* content, NSError* error) {
        if (error || !content) {
            NSLog(@"[audio_capture] Failed to get shareable content: %@", error);
            return;
        }

        SCDisplay* mainDisplay = [[content displays] firstObject];
        if (!mainDisplay) {
            NSLog(@"[audio_capture] No display found");
            return;
        }

        SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:mainDisplay
                                                          excludingWindows:@[]];

        SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];

        // System audio
        [config setCapturesAudio:YES];
        [config setExcludesCurrentProcessAudio:YES];
        [config setSampleRate:48000];
        [config setChannelCount:2];

        // Microphone (macOS 15+). Setting captureMicrophone = YES adds a
        // SCStreamOutputTypeMicrophone sample buffer stream alongside the
        // system audio one. The mic capture is shared at the HAL level,
        // so concurrent apps (Meet/Zoom/Discord/Telegram) keep working.
        BOOL micViaSCK = NO;
        if (@available(macOS 15.0, *)) {
            if (scStreamShouldCaptureMic()) {
                [config setCaptureMicrophone:YES];
                micViaSCK = YES;
                NSLog(@"[audio_capture] SCK microphone capture enabled (shared with other apps)");
            }
        }

        // Minimize video overhead (we only want audio)
        [config setWidth:2];
        [config setHeight:2];
        [config setMinimumFrameInterval:CMTimeMake(1, 1)];
        [config setShowsCursor:NO];

        HintyStreamDelegate* delegate = [[HintyStreamDelegate alloc] init];
        gStreamDelegate = delegate;
        gStreamOutput = delegate;

        NSError* streamError = nil;
        gStream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:delegate];

        [gStream addStreamOutput:delegate type:SCStreamOutputTypeAudio
                  sampleHandlerQueue:dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_HIGH, 0)
                               error:&streamError];
        if (streamError) {
            NSLog(@"[audio_capture] Failed to add system audio output: %@", streamError);
            return;
        }

        if (micViaSCK) {
            if (@available(macOS 15.0, *)) {
                NSError* micOutputError = nil;
                [gStream addStreamOutput:delegate type:SCStreamOutputTypeMicrophone
                      sampleHandlerQueue:dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_HIGH, 0)
                                   error:&micOutputError];
                if (micOutputError) {
                    NSLog(@"[audio_capture] Failed to add mic output to SCStream: %@", micOutputError);
                }
            }
        }

        [gStream startCaptureWithCompletionHandler:^(NSError* startError) {
            if (startError) {
                NSLog(@"[audio_capture] Failed to start capture: %@", startError);
                gIsCapturing = false;
            } else {
                NSLog(@"[audio_capture] SCStream started (system audio%s)",
                      micViaSCK ? " + microphone" : "");
            }
        }];
    }];
}

static void stopSystemAudioCapture() API_AVAILABLE(macos(13.0)) {
    if (gStream) {
        [gStream stopCaptureWithCompletionHandler:^(NSError* error) {
            if (error) {
                NSLog(@"[audio_capture] Error stopping stream: %@", error);
            }
            NSLog(@"[audio_capture] System audio capture stopped");
        }];
        gStream = nil;
        gStreamDelegate = nil;
        gStreamOutput = nil;
    }
}

// ── N-API bindings ──

Napi::Value CheckPermission(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (@available(macOS 13.0, *)) {
        // Check screen recording permission (required for ScreenCaptureKit)
        // There's no direct API to check SCK permission status.
        // We use CGPreflightScreenCaptureAccess() which is available since macOS 10.15
        bool hasScreenAccess = CGPreflightScreenCaptureAccess();

        // Check microphone permission
        AVAuthorizationStatus micStatus = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];

        if (hasScreenAccess && micStatus == AVAuthorizationStatusAuthorized) {
            return Napi::String::New(env, "granted");
        } else if (micStatus == AVAuthorizationStatusDenied || !hasScreenAccess) {
            return Napi::String::New(env, "denied");
        } else {
            return Napi::String::New(env, "unknown");
        }
    }

    return Napi::String::New(env, "unsupported");
}

Napi::Value RequestPermission(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (@available(macOS 13.0, *)) {
        // Request screen capture permission
        bool screenGranted = CGRequestScreenCaptureAccess();

        // Request microphone permission
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL micGranted) {
            // Note: This callback may be on a background thread.
            // The promise is already resolved synchronously below for screen,
            // and mic permission triggers a system dialog asynchronously.
        }];

        deferred.Resolve(Napi::Boolean::New(env, screenGranted));
    } else {
        deferred.Resolve(Napi::Boolean::New(env, false));
    }

    return deferred.Promise();
}

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (gIsCapturing) {
        return Napi::Boolean::New(env, false);
    }

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected callback function").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Create ThreadSafeFunction for sending audio chunks back to JS
    gTsfn = Napi::ThreadSafeFunction::New(
        env,
        info[0].As<Napi::Function>(),
        "AudioChunkCallback",
        0,   // unlimited queue
        1    // initial thread count
    );

    gIsCapturing = true;

    // Clear buffers and reset the echo canceller filter. Since both SCK
    // streams deliver audio starting from wall-time 0 of the capture and
    // we always pop from the oldest samples first, the streams are
    // naturally aligned at the sample level regardless of SCK's
    // per-stream delivery latency.
    {
        std::lock_guard<std::mutex> lock(gBufferMutex);
        gSystemBuffer.clear();
        gMicBuffer.clear();
    }
    gEchoCanceller.reset();

    // Start capture sources. SCK handles ONLY system audio; the mic is
    // always captured via AVAudioEngine's plain input tap (no VPIO), on
    // all macOS versions. See the comment at scStreamShouldCaptureMic for
    // why we avoid SCK's captureMicrophone even when it's available.
    if (@available(macOS 13.0, *)) {
        startSystemAudioCapture();
    }
    startMicCaptureFallback();
    startFlushTimer();

    NSLog(@"[audio_capture] Capture started (system audio via SCK, mic via AVAudioEngine plain tap)");
    return Napi::Boolean::New(env, true);
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!gIsCapturing) {
        return env.Undefined();
    }

    gIsCapturing = false;

    stopFlushTimer();
    stopMicCaptureFallback();

    if (@available(macOS 13.0, *)) {
        stopSystemAudioCapture();
    }

    // Release the TSFN
    gTsfn.Release();

    // Clear buffers
    {
        std::lock_guard<std::mutex> lock(gBufferMutex);
        gSystemBuffer.clear();
        gMicBuffer.clear();
    }

    NSLog(@"[audio_capture] Capture stopped");
    return env.Undefined();
}

Napi::Value IsCapturing(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), gIsCapturing.load());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("checkPermission", Napi::Function::New(env, CheckPermission));
    exports.Set("requestPermission", Napi::Function::New(env, RequestPermission));
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
    exports.Set("isCapturing", Napi::Function::New(env, IsCapturing));
    return exports;
}

NODE_API_MODULE(audio_capture, Init)
