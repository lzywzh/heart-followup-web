# 本地中文语音模型来源

引擎为 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)，使用该项目 Apache-2.0 许可证。CPU 推理，无云端语音账户或按次付费接口。

声学模型为 [matcha-icefall-zh-baker](https://huggingface.co/csukuangfj/matcha-icefall-zh-baker)，模型仓库标注 Apache-2.0，由 sherpa-onnx 官方预训练模型文档列出。声码器为 [vocos-22khz-univ.onnx](https://huggingface.co/k2-fsa/sherpa-onnx-models/blob/main/vocoder-models/vocos-22khz-univ.onnx)，仓库标注 Apache-2.0。部署保留模型仓库 README，依赖自身的许可证随安装包保留；模型权重不纳入应用 Git 仓库。

下载后的声学模型 SHA256：`ff1cc7f7abdedc4eeec668a4a0dc2e72a0c314c5637d5fce885345b490bd08de`。

声码器 SHA256：`0574a135aa1db2de6e181050db2ec528496cacd4a4701fc5d7faf9f9804c0081`。

下载后必须核对模型和声码器的上述 SHA256，并保留上游模型说明。模型附带的词典/规则文件只用于中文发音与数字读法，不接收网络指令。仓库不包含模型权重；下载步骤见 `docs/setup/voice.md`。

输入仅来自权限校验后的已保存助手问题，通过服务器回环接口传递。服务不保存文本或 WAV，不记录请求正文；正式服务关闭标准输出/错误输出，避免底层库把文本片段写入日志。合成结果由应用短时内存缓存，HTTP 响应禁止浏览器持久缓存。

## 中文识别模型 SenseVoice

ASR 使用 FunAudioLLM / Alibaba 的 **SenseVoiceSmall**，通过 sherpa-onnx 的 SenseVoice int8 ONNX 转换运行。转换仓库：<https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17>；原始模型项目：<https://github.com/FunAudioLLM/SenseVoice>。保留模型名称、原作者信息、下载仓库的 README 和 LICENSE。

`model.int8.onnx` SHA256：`c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`（239233841 字节）。模型目录还必须包含同仓库的 `tokens.txt`。

模型权重采用 **FunASR Model Open Source License Agreement v1.1**，版权归 Alibaba Group（2023–2028）；不属于本应用的 MIT 许可，也不能将引擎的 Apache-2.0 当作模型许可。许可副本见 `speech/licenses/SenseVoice_MODEL_LICENSE`；其上游版本为 <https://github.com/modelscope/FunASR/blob/58830eca4012644aac0c3218c3ccc7d98f003fda/MODEL_LICENSE>。权重不纳入仓库。

识别在内存中进行，不保存原始录音、不输出转写日志，不使用医学词表提示或根据上下文猜测替换患者用词。模型仍可能误识同音字、否定词和数字；合成语音回归不能代替目标手机与真实说话者的测试。
