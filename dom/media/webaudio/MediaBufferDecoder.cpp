/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MediaBufferDecoder.h"
#include "mozilla/dom/AudioContextBinding.h"
#include "mozilla/dom/BaseAudioContextBinding.h"
#include "mozilla/dom/DOMException.h"
#include "mozilla/dom/ScriptSettings.h"
#include "mozilla/AbstractThread.h"
#include <speex/speex_resampler.h>
#include "nsXPCOMCIDInternal.h"
#include "nsComponentManagerUtils.h"
#include "MediaFormatReader.h"
#include "MediaQueue.h"
#include "BufferMediaResource.h"
#include "DecoderTraits.h"
#include "AudioContext.h"
#include "AudioBuffer.h"
#include "js/MemoryFunctions.h"
#include "MediaContainerType.h"
#include "nsContentUtils.h"
#include "nsIScriptObjectPrincipal.h"
#include "nsIScriptError.h"
#include "nsMimeTypes.h"
#include "VideoUtils.h"
#include "WebAudioUtils.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/Telemetry.h"
#include "nsPrintfCString.h"
#include "AudioNodeEngine.h"

namespace mozilla {

extern LazyLogModule gMediaDecoderLog;

using namespace dom;

class ReportResultTask final : public Runnable {
 public:
  ReportResultTask(WebAudioDecodeJob& aDecodeJob,
                   WebAudioDecodeJob::ResultFn aFunction,
                   WebAudioDecodeJob::ErrorCode aErrorCode)
      : Runnable("ReportResultTask"),
        mDecodeJob(aDecodeJob),
        mFunction(aFunction),
        mErrorCode(aErrorCode) {
    MOZ_ASSERT(aFunction);
  }

  NS_IMETHOD Run() override {
    MOZ_ASSERT(NS_IsMainThread());

    (mDecodeJob.*mFunction)(mErrorCode);

    return NS_OK;
  }

 private:
  // Note that the mDecodeJob member will probably die when mFunction is run.
  // Therefore, it is not safe to do anything fancy with it in this class.
  // Really, this class is only used because nsRunnableMethod doesn't support
  // methods accepting arguments.
  WebAudioDecodeJob& mDecodeJob;
  WebAudioDecodeJob::ResultFn mFunction;
  WebAudioDecodeJob::ErrorCode mErrorCode;
};

enum class PhaseEnum : int { Decode, AllocateBuffer, Done };

class MediaDecodeTask final : public Runnable {
 public:
  MediaDecodeTask(const MediaContainerType& aContainerType, uint8_t* aBuffer,
                  uint32_t aLength, WebAudioDecodeJob& aDecodeJob)
      : Runnable("MediaDecodeTask"),
        mContainerType(aContainerType),
        mBuffer(aBuffer),
        mLength(aLength),
        mDecodeJob(aDecodeJob),
        mPhase(PhaseEnum::Decode),
        mFirstFrameDecoded(false) {
    MOZ_ASSERT(aBuffer);
    MOZ_ASSERT(NS_IsMainThread());
  }

  NS_IMETHOD Run() override;
  bool CreateReader();
  MediaFormatReader* Reader() {
    MOZ_ASSERT(mDecoderReader);
    return mDecoderReader;
  }

 private:
  void ReportFailureOnMainThread(WebAudioDecodeJob::ErrorCode aErrorCode) {
    if (NS_IsMainThread()) {
      Cleanup();
      mDecodeJob.OnFailure(aErrorCode);
    } else {
      // Take extra care to cleanup on the main thread
      mMainThread->Dispatch(NewRunnableMethod("MediaDecodeTask::Cleanup", this,
                                              &MediaDecodeTask::Cleanup));

      nsCOMPtr<nsIRunnable> event = new ReportResultTask(
          mDecodeJob, &WebAudioDecodeJob::OnFailure, aErrorCode);
      mMainThread->Dispatch(event.forget());
    }
  }

  void Decode();
  void OnMetadataRead(MetadataHolder&& aMetadata);
  void OnMetadataNotRead(const MediaResult& aError);
  void RequestSample();
  void SampleDecoded(RefPtr<AudioData> aData);
  void SampleNotDecoded(const MediaResult& aError);
  void FinishDecode();
  void AllocateBuffer();
  void CallbackTheResult();

  void Cleanup() {
    MOZ_ASSERT(NS_IsMainThread());
    mDecoderReader = nullptr;
    JS_free(nullptr, mBuffer);
  }

 private:
  MediaContainerType mContainerType;
  uint8_t* mBuffer;
  uint32_t mLength;
  WebAudioDecodeJob& mDecodeJob;
  PhaseEnum mPhase;
  RefPtr<MediaFormatReader> mDecoderReader;
  MediaInfo mMediaInfo;
  MediaQueue<AudioData> mAudioQueue;
  RefPtr<AbstractThread> mMainThread;
  bool mFirstFrameDecoded;
};

NS_IMETHODIMP
MediaDecodeTask::Run() {
  MOZ_ASSERT(mDecoderReader);
  switch (mPhase) {
    case PhaseEnum::Decode:
      Decode();
      break;
    case PhaseEnum::AllocateBuffer:
      AllocateBuffer();
      break;
    case PhaseEnum::Done:
      break;
  }

  return NS_OK;
}

bool MediaDecodeTask::CreateReader() {
  MOZ_ASSERT(NS_IsMainThread());

  RefPtr<BufferMediaResource> resource =
      new BufferMediaResource(static_cast<uint8_t*>(mBuffer), mLength);

  mMainThread = mDecodeJob.mContext->GetOwnerGlobal()->AbstractMainThreadFor(
      TaskCategory::Other);

  // If you change this list to add support for new decoders, please consider
  // updating HTMLMediaElement::CreateDecoder as well.

  MediaFormatReaderInit init;
  init.mResource = resource;
  mDecoderReader = DecoderTraits::CreateReader(mContainerType, init);

  if (!mDecoderReader) {
    return false;
  }

  nsresult rv = mDecoderReader->Init();
  if (NS_FAILED(rv)) {
    return false;
  }

  return true;
}

class AutoResampler final {
 public:
  AutoResampler() : mResampler(nullptr) {}
  ~AutoResampler() {
    if (mResampler) {
      speex_resampler_destroy(mResampler);
    }
  }
  operator SpeexResamplerState*() const {
    MOZ_ASSERT(mResampler);
    return mResampler;
  }
  void operator=(SpeexResamplerState* aResampler) { mResampler = aResampler; }

 private:
  SpeexResamplerState* mResampler;
};

void MediaDecodeTask::Decode() {
  MOZ_ASSERT(!NS_IsMainThread());

  mDecoderReader->AsyncReadMetadata()->Then(
      mDecoderReader->OwnerThread(), __func__, this,
      &MediaDecodeTask::OnMetadataRead, &MediaDecodeTask::OnMetadataNotRead);
}

void MediaDecodeTask::OnMetadataRead(MetadataHolder&& aMetadata) {
  mMediaInfo = *aMetadata.mInfo;
  if (!mMediaInfo.HasAudio()) {
    mDecoderReader->Shutdown();
    ReportFailureOnMainThread(WebAudioDecodeJob::NoAudio);
    return;
  }

  nsCString codec;
  if (!mMediaInfo.mAudio.GetAsAudioInfo()->mMimeType.IsEmpty()) {
    codec = nsPrintfCString(
        "webaudio; %s", mMediaInfo.mAudio.GetAsAudioInfo()->mMimeType.get());
  } else {
    codec = nsPrintfCString("webaudio;resource; %s",
                            mContainerType.Type().AsString().Data());
  }

  nsCOMPtr<nsIRunnable> task = NS_NewRunnableFunction(
      "MediaDecodeTask::OnMetadataRead", [codec]() -> void {
        MOZ_ASSERT(!codec.IsEmpty());
        MOZ_LOG(gMediaDecoderLog, LogLevel::Debug,
                ("Telemetry (WebAudio) MEDIA_CODEC_USED= '%s'", codec.get()));
        Telemetry::Accumulate(Telemetry::HistogramID::MEDIA_CODEC_USED, codec);
      });
  SystemGroup::Dispatch(TaskCategory::Other, task.forget());

  RequestSample();
}

void MediaDecodeTask::OnMetadataNotRead(const MediaResult& aReason) {
  mDecoderReader->Shutdown();
  ReportFailureOnMainThread(WebAudioDecodeJob::InvalidContent);
}

void MediaDecodeTask::RequestSample() {
  mDecoderReader->RequestAudioData()->Then(
      mDecoderReader->OwnerThread(), __func__, this,
      &MediaDecodeTask::SampleDecoded, &MediaDecodeTask::SampleNotDecoded);
}

void MediaDecodeTask::SampleDecoded(RefPtr<AudioData> aData) {
  MOZ_ASSERT(!NS_IsMainThread());
  mAudioQueue.Push(aData);
  if (!mFirstFrameDecoded) {
    mDecoderReader->ReadUpdatedMetadata(&mMediaInfo);
    mFirstFrameDecoded = true;
  }
  RequestSample();
}

void MediaDecodeTask::SampleNotDecoded(const MediaResult& aError) {
  MOZ_ASSERT(!NS_IsMainThread());
  if (aError == NS_ERROR_DOM_MEDIA_END_OF_STREAM) {
    FinishDecode();
  } else {
    mDecoderReader->Shutdown();
    ReportFailureOnMainThread(WebAudioDecodeJob::InvalidContent);
  }
}

void MediaDecodeTask::FinishDecode() {
  mDecoderReader->Shutdown();

  uint32_t frameCount = mAudioQueue.AudioFramesCount();
  uint32_t channelCount = mMediaInfo.mAudio.mChannels;
  uint32_t sampleRate = mMediaInfo.mAudio.mRate;

  if (!frameCount || !channelCount || !sampleRate) {
    ReportFailureOnMainThread(WebAudioDecodeJob::InvalidContent);
    return;
  }

  const uint32_t destSampleRate = mDecodeJob.mContext->SampleRate();
  AutoResampler resampler;

  uint32_t resampledFrames = frameCount;
  if (sampleRate != destSampleRate) {
    resampledFrames = static_cast<uint32_t>(
        static_cast<uint64_t>(destSampleRate) *
        static_cast<uint64_t>(frameCount) / static_cast<uint64_t>(sampleRate));

    resampler = speex_resampler_init(channelCount, sampleRate, destSampleRate,
                                     SPEEX_RESAMPLER_QUALITY_DEFAULT, nullptr);
    speex_resampler_skip_zeros(resampler);
    resampledFrames += speex_resampler_get_output_latency(resampler);
  }

  // Allocate contiguous channel buffers.  Note that if we end up resampling,
  // we may write fewer bytes than mResampledFrames to the output buffer, in
  // which case writeIndex will tell us how many valid samples we have.
  mDecodeJob.mBuffer.mChannelData.SetLength(channelCount);
#if AUDIO_OUTPUT_FORMAT == AUDIO_FORMAT_FLOAT32
  // This buffer has separate channel arrays that could be transferred to
  // JS_NewArrayBufferWithContents(), but AudioBuffer::RestoreJSChannelData()
  // does not yet take advantage of this.
  RefPtr<ThreadSharedFloatArrayBufferList> buffer =
      ThreadSharedFloatArrayBufferList::Create(channelCount, resampledFrames,
                                               fallible);
  if (!buffer) {
    ReportFailureOnMainThread(WebAudioDecodeJob::UnknownError);
    return;
  }
  for (uint32_t i = 0; i < channelCount; ++i) {
    mDecodeJob.mBuffer.mChannelData[i] = buffer->GetData(i);
  }
#else
  RefPtr<SharedBuffer> buffer = SharedBuffer::Create(
      sizeof(AudioDataValue) * resampledFrames * channelCount);
  if (!buffer) {
    ReportFailureOnMainThread(WebAudioDecodeJob::UnknownError);
    return;
  }
  auto data = static_cast<AudioDataValue*>(floatBuffer->Data());
  for (uint32_t i = 0; i < channelCount; ++i) {
    mDecodeJob.mBuffer.mChannelData[i] = data;
    data += resampledFrames;
  }
#endif
  mDecodeJob.mBuffer.mBuffer = buffer.forget();
  mDecodeJob.mBuffer.mVolume = 1.0f;
  mDecodeJob.mBuffer.mBufferFormat = AUDIO_OUTPUT_FORMAT;

  uint32_t writeIndex = 0;
  RefPtr<AudioData> audioData;
  while ((audioData = mAudioQueue.PopFront())) {
    audioData->EnsureAudioBuffer();  // could lead to a copy :(
    const AudioDataValue* bufferData =
        static_cast<AudioDataValue*>(audioData->mAudioBuffer->Data());

    if (sampleRate != destSampleRate) {
      const uint32_t maxOutSamples = resampledFrames - writeIndex;

      for (uint32_t i = 0; i < audioData->mChannels; ++i) {
        uint32_t inSamples = audioData->Frames();
        uint32_t outSamples = maxOutSamples;
        AudioDataValue* outData =
            mDecodeJob.mBuffer.ChannelDataForWrite<AudioDataValue>(i) +
            writeIndex;

        WebAudioUtils::SpeexResamplerProcess(
            resampler, i, &bufferData[i * audioData->Frames()], &inSamples,
            outData, &outSamples);

        if (i == audioData->mChannels - 1) {
          writeIndex += outSamples;
          MOZ_ASSERT(writeIndex <= resampledFrames);
          MOZ_ASSERT(inSamples == audioData->Frames());
        }
      }
    } else {
      for (uint32_t i = 0; i < audioData->mChannels; ++i) {
        AudioDataValue* outData =
            mDecodeJob.mBuffer.ChannelDataForWrite<AudioDataValue>(i) +
            writeIndex;
        PodCopy(outData, &bufferData[i * audioData->Frames()],
                audioData->Frames());

        if (i == audioData->mChannels - 1) {
          writeIndex += audioData->Frames();
        }
      }
    }
  }

  if (sampleRate != destSampleRate) {
    uint32_t inputLatency = speex_resampler_get_input_latency(resampler);
    const uint32_t maxOutSamples = resampledFrames - writeIndex;
    for (uint32_t i = 0; i < channelCount; ++i) {
      uint32_t inSamples = inputLatency;
      uint32_t outSamples = maxOutSamples;
      AudioDataValue* outData =
          mDecodeJob.mBuffer.ChannelDataForWrite<AudioDataValue>(i) +
          writeIndex;

      WebAudioUtils::SpeexResamplerProcess(resampler, i,
                                           (AudioDataValue*)nullptr, &inSamples,
                                           outData, &outSamples);

      if (i == channelCount - 1) {
        writeIndex += outSamples;
        MOZ_ASSERT(writeIndex <= resampledFrames);
        MOZ_ASSERT(inSamples == inputLatency);
      }
    }
  }

  mDecodeJob.mBuffer.mDuration = writeIndex;
  mPhase = PhaseEnum::AllocateBuffer;
  mMainThread->Dispatch(do_AddRef(this));
}

void MediaDecodeTask::AllocateBuffer() {
  MOZ_ASSERT(NS_IsMainThread());

  if (!mDecodeJob.AllocateBuffer()) {
    ReportFailureOnMainThread(WebAudioDecodeJob::UnknownError);
    return;
  }

  mPhase = PhaseEnum::Done;
  CallbackTheResult();
}

void MediaDecodeTask::CallbackTheResult() {
  MOZ_ASSERT(NS_IsMainThread());

  Cleanup();

  // Now, we're ready to call the script back with the resulting buffer
  mDecodeJob.OnSuccess(WebAudioDecodeJob::NoError);
}

bool WebAudioDecodeJob::AllocateBuffer() {
  MOZ_ASSERT(!mOutput);
  MOZ_ASSERT(NS_IsMainThread());

  // Now create the AudioBuffer
  mOutput = AudioBuffer::Create(mContext->GetOwner(), mContext->SampleRate(),
                                std::move(mBuffer));
  return mOutput != nullptr;
}

void AsyncDecodeWebAudio(const char* aContentType, uint8_t* aBuffer,
                         uint32_t aLength, WebAudioDecodeJob& aDecodeJob) {
  Maybe<MediaContainerType> containerType =
      MakeMediaContainerType(aContentType);
  // Do not attempt to decode the media if we were not successful at sniffing
  // the container type.
  if (!*aContentType || strcmp(aContentType, APPLICATION_OCTET_STREAM) == 0 ||
      !containerType) {
    nsCOMPtr<nsIRunnable> event =
        new ReportResultTask(aDecodeJob, &WebAudioDecodeJob::OnFailure,
                             WebAudioDecodeJob::UnknownContent);
    JS_free(nullptr, aBuffer);
    aDecodeJob.mContext->Dispatch(event.forget());
    return;
  }

  RefPtr<MediaDecodeTask> task =
      new MediaDecodeTask(*containerType, aBuffer, aLength, aDecodeJob);
  if (!task->CreateReader()) {
    nsCOMPtr<nsIRunnable> event =
        new ReportResultTask(aDecodeJob, &WebAudioDecodeJob::OnFailure,
                             WebAudioDecodeJob::UnknownError);
    aDecodeJob.mContext->Dispatch(event.forget());
  } else {
    // If we did this without a temporary:
    //   task->Reader()->OwnerThread()->Dispatch(task.forget())
    // we might evaluate the task.forget() before calling Reader(). Enforce
    // a non-crashy order-of-operations.
    TaskQueue* taskQueue = task->Reader()->OwnerThread();
    nsresult rv = taskQueue->Dispatch(task.forget());
    MOZ_DIAGNOSTIC_ASSERT(NS_SUCCEEDED(rv));
    Unused << rv;
  }
}

WebAudioDecodeJob::WebAudioDecodeJob(AudioContext* aContext, Promise* aPromise,
                                     DecodeSuccessCallback* aSuccessCallback,
                                     DecodeErrorCallback* aFailureCallback)
    : mContext(aContext),
      mPromise(aPromise),
      mSuccessCallback(aSuccessCallback),
      mFailureCallback(aFailureCallback) {
  MOZ_ASSERT(aContext);
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_COUNT_CTOR(WebAudioDecodeJob);
}

WebAudioDecodeJob::~WebAudioDecodeJob() {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_COUNT_DTOR(WebAudioDecodeJob);
}

void WebAudioDecodeJob::OnSuccess(ErrorCode aErrorCode) {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(aErrorCode == NoError);

  if (mSuccessCallback) {
    ErrorResult rv;
    mSuccessCallback->Call(*mOutput, rv);
    // Ignore errors in calling the callback, since there is not much that we
    // can do about it here.
    rv.SuppressException();
  }
  mPromise->MaybeResolve(mOutput);

  mContext->RemoveFromDecodeQueue(this);
}

void WebAudioDecodeJob::OnFailure(ErrorCode aErrorCode) {
  MOZ_ASSERT(NS_IsMainThread());

  const char* errorMessage;
  switch (aErrorCode) {
    case UnknownContent:
      errorMessage = "MediaDecodeAudioDataUnknownContentType";
      break;
    case InvalidContent:
      errorMessage = "MediaDecodeAudioDataInvalidContent";
      break;
    case NoAudio:
      errorMessage = "MediaDecodeAudioDataNoAudio";
      break;
    case NoError:
      MOZ_FALLTHROUGH_ASSERT("Who passed NoError to OnFailure?");
      // Fall through to get some sort of a sane error message if this actually
      // happens at runtime.
    case UnknownError:
      MOZ_FALLTHROUGH;
    default:
      errorMessage = "MediaDecodeAudioDataUnknownError";
      break;
  }

  Document* doc = nullptr;
  if (nsPIDOMWindowInner* pWindow = mContext->GetParentObject()) {
    doc = pWindow->GetExtantDoc();
  }
  nsContentUtils::ReportToConsole(
      nsIScriptError::errorFlag, NS_LITERAL_CSTRING("Media"), doc,
      nsContentUtils::eDOM_PROPERTIES, errorMessage);

  // Ignore errors in calling the callback, since there is not much that we can
  // do about it here.
  if (mFailureCallback) {
    nsAutoCString errorString(errorMessage);
    RefPtr<DOMException> exception = DOMException::Create(
        NS_ERROR_DOM_ENCODING_NOT_SUPPORTED_ERR, errorString);
    mFailureCallback->Call(*exception);
  }

  mPromise->MaybeReject(NS_ERROR_DOM_ENCODING_NOT_SUPPORTED_ERR);

  mContext->RemoveFromDecodeQueue(this);
}

size_t WebAudioDecodeJob::SizeOfExcludingThis(
    MallocSizeOf aMallocSizeOf) const {
  size_t amount = 0;
  if (mSuccessCallback) {
    amount += mSuccessCallback->SizeOfIncludingThis(aMallocSizeOf);
  }
  if (mFailureCallback) {
    amount += mFailureCallback->SizeOfIncludingThis(aMallocSizeOf);
  }
  if (mOutput) {
    amount += mOutput->SizeOfIncludingThis(aMallocSizeOf);
  }
  amount += mBuffer.SizeOfExcludingThis(aMallocSizeOf, false);
  return amount;
}

size_t WebAudioDecodeJob::SizeOfIncludingThis(
    MallocSizeOf aMallocSizeOf) const {
  return aMallocSizeOf(this) + SizeOfExcludingThis(aMallocSizeOf);
}

}  // namespace mozilla
