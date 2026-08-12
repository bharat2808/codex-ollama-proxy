'use strict';

const {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
} = require('werift');
const {
  PcmPushToTalkSegmenter,
  PcmSpeechSegmenter,
  createFfmpegRtpDecoder,
  createFfmpegRtpPlayer,
} = require('./voice-audio');

async function createWeriftVoicePeer({
  offerSdp,
  inputMode = 'vad',
  onDataEvent = () => {},
  onSpeechEnd = () => {},
  onSpeechStart = () => {},
  onSpeech,
  onClose = () => {},
} = {}) {
  if (!offerSdp) throw new Error('WebRTC offer SDP is required');
  if (typeof onSpeech !== 'function') throw new Error('onSpeech is required');

  const peerConnection = new RTCPeerConnection();
  const outputTrack = new MediaStreamTrack({ kind: 'audio' });
  const outputStream = new MediaStream([outputTrack]);
  const pendingDataEvents = [];
  const decoders = [];
  const inputSegmenters = [];
  let dataChannel = null;
  let inputSubscription = null;
  let connectionSubscription = null;
  let inputActive = false;
  let closing = false;

  function flushDataEvents() {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    for (const payload of pendingDataEvents.splice(0)) dataChannel.send(payload);
  }

  peerConnection.onDataChannel.subscribe((channel) => {
    if (channel.label !== 'oai-events') return;
    dataChannel = channel;
    channel.onopen = flushDataEvents;
    channel.onmessage = (message) => {
      try {
        const raw = typeof message?.data === 'string' ? message.data : message;
        onDataEvent(JSON.parse(String(raw)));
      } catch {}
    };
    channel.onclose = () => {
      if (!closing) onClose();
    };
    flushDataEvents();
  });
  connectionSubscription = peerConnection.connectionStateChange.subscribe((state) => {
    if (!closing && (state === 'closed' || state === 'failed')) onClose();
  });
  peerConnection.onTrack.subscribe((track) => {
    if (track.kind !== 'audio' || inputSubscription) return;
    const Segmenter = inputMode === 'push-to-talk'
      ? PcmPushToTalkSegmenter
      : PcmSpeechSegmenter;
    const segmenter = new Segmenter({
      onSpeechEnd,
      onSpeechStart,
      onSpeech,
    });
    inputSegmenters.push(segmenter);
    if (inputActive && typeof segmenter.start === 'function') segmenter.start();
    const decoder = createFfmpegRtpDecoder({
      onPcm(chunk) {
        segmenter.push(chunk).catch(() => {});
      },
    });
    decoders.push(decoder);
    inputSubscription = track.onReceiveRtp.subscribe((packet) => {
      decoder.then((activeDecoder) => activeDecoder.pushRtp(packet)).catch(() => {});
    });
  });

  await peerConnection.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  peerConnection.addTrack(outputTrack, outputStream);
  const player = await createFfmpegRtpPlayer({ track: outputTrack });
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  return {
    answerSdp: peerConnection.localDescription.sdp,
    outputTrack,
    playAudioStream: player.playAudioStream,
    stopAudio: player.stopAudio,
    startInput() {
      inputActive = true;
      for (const segmenter of inputSegmenters) {
        if (typeof segmenter.start === 'function') segmenter.start();
      }
    },
    commitInput() {
      inputActive = false;
      return Promise.all(inputSegmenters.map((segmenter) => (
        typeof segmenter.commit === 'function' ? segmenter.commit() : undefined
      )));
    },
    cancelInput() {
      inputActive = false;
      for (const segmenter of inputSegmenters) {
        if (typeof segmenter.cancel === 'function') segmenter.cancel();
      }
    },
    sendDataEvent(event) {
      pendingDataEvents.push(JSON.stringify(event));
      flushDataEvents();
    },
    async close() {
      closing = true;
      if (inputSubscription && typeof inputSubscription.unSubscribe === 'function') {
        inputSubscription.unSubscribe();
      }
      if (connectionSubscription && typeof connectionSubscription.unSubscribe === 'function') {
        connectionSubscription.unSubscribe();
      }
      await player.close();
      for (const decoder of decoders) {
        await decoder.then((activeDecoder) => activeDecoder.close()).catch(() => {});
      }
      outputTrack.stop();
      const iceTransports = [...peerConnection.iceTransports];
      await peerConnection.close();
      await Promise.allSettled(iceTransports.map((transport) => transport.stop()));
    },
  };
}

module.exports = {
  createWeriftVoicePeer,
};
