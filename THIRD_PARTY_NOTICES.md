# Third-Party Notices

`codex-universal-proxy` installs and invokes third-party components under their
own licenses. The project license does not replace those licenses.

## FFmpeg and ffmpeg-static

Voice transport uses the platform-specific FFmpeg executable installed by
`ffmpeg-static`. The selected builds include `libopus` and are distributed
under GPL-3.0-or-later. The installed dependency includes `ffmpeg.LICENSE`,
`ffmpeg.README`, and the `ffmpeg-static` license. Source and build provenance:

- https://github.com/eugeneware/ffmpeg-static
- https://github.com/FFmpeg/FFmpeg

## Transformers.js and ONNX Runtime

Local Whisper and Kokoro inference use `@huggingface/transformers` and
`onnxruntime-node`. Their license texts are included in the installed npm
dependencies.

## Kokoro

Text-to-speech uses `kokoro-js` and the Apache-2.0 licensed
`onnx-community/Kokoro-82M-v1.0-ONNX` model weights. Kokoro voice data ships
inside the `kokoro-js` dependency; model weights are downloaded into the
user-owned Codex cache on first setup.
