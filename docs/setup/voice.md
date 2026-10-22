# 本地中文语音服务

网页 API 通过回环 HTTP 调用两个独立的 CPU 服务。语音识别使用 faster-whisper，中文播报使用 sherpa-onnx / Matcha。模型权重需要单独下载，不能用 DeepSeek 密钥替代 ASR/TTS。

以下命令在项目根目录的 Linux / macOS 终端执行；小内存机器建议将语音服务放在独立服务器上。示例模型为 faster-whisper-base，实际效果与速度应在目标设备和语料上评估。

## 环境与模型

```bash
python3 -m venv .venv-speech
. .venv-speech/bin/activate
python -m pip install -r speech/requirements.txt -r speech/requirements-asr.txt huggingface_hub
hf download Systran/faster-whisper-base --local-dir speech/models/asr
hf download csukuangfj/matcha-icefall-zh-baker --local-dir speech/models/matcha-icefall-zh-baker --include model-steps-3.onnx lexicon.txt tokens.txt date.fst number.fst phone.fst README.md
hf download k2-fsa/sherpa-onnx-models vocoder-models/vocos-22khz-univ.onnx --local-dir speech/models
cp speech/models/vocoder-models/vocos-22khz-univ.onnx speech/models/vocos-22khz-univ.onnx
```

下载并保留模型仓库的许可证与 README。检查以下文件的 SHA256，值须与 `speech/MODEL_NOTICE.md` 一致：

```bash
sha256sum speech/models/matcha-icefall-zh-baker/model-steps-3.onnx
sha256sum speech/models/vocos-22khz-univ.onnx
```

macOS 默认可将 `sha256sum` 替换为 `shasum -a 256`；Windows PowerShell 可使用 `Get-FileHash -Algorithm SHA256`。

## 启动

两个终端分别激活同一个虚拟环境，在项目根目录执行：

```bash
ASR_MODEL_PATH="$PWD/speech/models/asr" python speech/local_asr.py
```

```bash
TTS_MODEL_ROOT="$PWD/speech/models" python speech/local_tts.py
```

Windows 可以使用虚拟环境中的 `python.exe`，通过 `$env:ASR_MODEL_PATH` 和 `$env:TTS_MODEL_ROOT` 指定绝对模型目录。正式服务配置参考 `deploy/heart-followup-asr.service` 与 `deploy/heart-followup-tts.service`。

确认两个服务都已真正加载模型：

```bash
curl -fsS http://127.0.0.1:3010/health
curl -fsS http://127.0.0.1:3020/health
```

二者应报告 `ready=true`。在网页 `.env` 中配置：

```dotenv
LOCAL_ASR_URL=http://127.0.0.1:3010
LOCAL_TTS_URL=http://127.0.0.1:3020
VOICE_TTS_MODE=server
```

重启网页 API，医生服务状态页可检查识别和合成服务。之后在患者端允许麦克风，确认能听到问题并完成一句回答。

## 行为与边界

ASR 接受有限大小的音频，内存解码，单并发，不记录请求正文。TTS 限制文本 500 字、单并发；合成超过 22 秒时进程退出，正式部署需使用 systemd 的 `Restart=on-failure` 恢复。手动终端运行时需要自行重新启动。API 还有独立的超时、权限、缓存与版本检查。

服务只绑定 `127.0.0.1`。若网页与语音服务不在同一机器，需单独设计私网连接、鉴权与加密；不要把这两个无独立账号鉴权的回环接口直接暴露公网。

服务器播报解决的是缺少 SpeechSynthesis 的播放路径。麦克风、AudioWorklet、系统音频权限和微信版本仍会影响实机体验。保持页面前台，切后台后手动恢复；无法播放时检查媒体音量，并保留具体错误以便定位。
