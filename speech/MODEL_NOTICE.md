# 本机中文合成模型来源

引擎为 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)，使用该项目 Apache-2.0 许可证。CPU 推理，无云端语音账户或按次付费接口。

声学模型为 [matcha-icefall-zh-baker](https://huggingface.co/csukuangfj/matcha-icefall-zh-baker)，模型仓库标注 Apache-2.0，由 sherpa-onnx 官方预训练模型文档列出。声码器为 [vocos-22khz-univ.onnx](https://huggingface.co/k2-fsa/sherpa-onnx-models/blob/main/vocoder-models/vocos-22khz-univ.onnx)，仓库标注 Apache-2.0。部署保留模型仓库 README，依赖自身的许可证随安装包保留；模型权重不纳入应用 Git 仓库。

下载后的声学模型 SHA256：`ff1cc7f7abdedc4eeec668a4a0dc2e72a0c314c5637d5fce885345b490bd08de`。

声码器 SHA256：`0574a135aa1db2de6e181050db2ec528496cacd4a4701fc5d7faf9f9804c0081`。

下载后必须核对模型和声码器的上述 SHA256，并保留上游模型说明。模型附带的词典/规则文件只用于中文发音与数字读法，不接收网络指令。仓库不包含模型权重；下载步骤见 `docs/setup/voice.md`。

输入仅来自权限校验后的已保存助手问题，通过服务器回环接口传递。服务不保存文本或 WAV，不记录请求正文；正式服务关闭标准输出/错误输出，避免底层库把文本片段写入日志。合成结果由应用短时内存缓存，HTTP 响应禁止浏览器持久缓存。
