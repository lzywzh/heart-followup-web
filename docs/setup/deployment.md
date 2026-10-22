# 通用部署说明

部署包含 PostgreSQL、网页 API、ASR、TTS 和 HTTPS 反向代理。`deploy/` 是需要填写的通用示例，不包含任何现有服务器的账号、IP、证书或数据库内容。建议先完成本地流程和目标手机的实机验证，再安排对外访问。

## 网页服务

在 Linux 服务器创建非 root 服务账号 `hf-web`，将源码安装到 `/opt/heart-followup-web`。使用 Node.js 24 安装依赖并构建：

```bash
npm ci
npm run build
```

准备 PostgreSQL 16 数据库。迁移所有者与运行账号应分开：所有者执行版本化迁移，为运行账号授予所需表、序列和 schema 使用权限；运行账号不拥有建表权限。开发 Compose 中的数据库所有者账号仅用于本地开发。

用迁移连接运行 `npm run db:migrate`，再通过 `npm run account:create -- clinician doctor 医生显示名` 创建初始医生。初始随机密码写入本机 `.runtime` 私有文件，通过受控方式交付。不要将这个文件复制进静态网站或代码仓库。

将运行配置放在 root 拥有、权限 600 的 `/etc/heart-followup-web.env`，至少配置：

```dotenv
NODE_ENV=production
AUTH_MODE=web
COLLECTION_MODE=ai
HOST=127.0.0.1
PORT=3200
PUBLIC_ORIGIN=https://followup.example.com
SESSION_SECRET=REPLACE_WITH_A_NEW_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS
DATABASE_URL=postgresql://RUNTIME_USER:URL_ENCODED_PASSWORD@127.0.0.1:5432/YOUR_DATABASE
DEEPSEEK_API_KEY=REPLACE_WITH_YOUR_OWN_KEY
LOCAL_ASR_URL=http://127.0.0.1:3010
LOCAL_TTS_URL=http://127.0.0.1:3020
VOICE_TTS_MODE=server
```

运行配置不放入迁移连接或测试连接。不要直接复制以上占位内容投入使用。生产采集模板需要医生在工作台核对并记录真实审核情况，不能通过软件测试代替专业审核。

安装 `deploy/heart-followup-web.service` 到 `/etc/systemd/system/`，核对目录、服务用户和文件读取权限。Node 与 Python 虚拟环境需安装在服务用户可读取、可执行的位置。

## 语音与 HTTPS

按 [voice.md](voice.md) 安装模型和语音依赖。示例约定：

| 服务 | Python / 源码 / 模型位置 |
|---|---|
| ASR | `/opt/heart-followup-asr/venv/bin/python`、`local_asr.py`、`models/asr/` |
| TTS | `/opt/heart-followup-tts/venv/bin/python`、`local_tts.py`、Matcha 模型目录与声码器 |

将相应 Python 源码复制到以上目录，保留模型许可。安装两个语音 systemd unit。确认所有路径后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now heart-followup-asr heart-followup-tts heart-followup-web
```

参考 `deploy/nginx.conf`，将所有 `followup.example.com` 和证书路径替换成自己的配置，配置受信任 TLS 证书及续期。公网只需要暴露反向代理，PostgreSQL、Node、ASR/TTS 端口均应保持回环或受控私网访问。

## 验证与更新

```bash
curl -fsS http://127.0.0.1:3200/api/v1/health
curl -fsS http://127.0.0.1:3010/health
curl -fsS http://127.0.0.1:3020/health
sudo systemctl is-active heart-followup-web heart-followup-asr heart-followup-tts
sudo nginx -t
```

随后检查公网登录、医生/患者账号隔离、任务、小结和实际手机录音播放。页面可打开或服务健康不代表实机语音已经通过。

更新前备份当前源码、运行配置和 PostgreSQL，并在临时数据库验证恢复。先验证新版本，再切换服务；数据库结构发生变化时按迁移版本核对回滚兼容性。不要在有新数据写入后用旧备份直接覆盖业务数据库。

可选的 `npm run db:backup` 和 `npm run db:restore-check -- 文件.dump` 要求显式设置自己的 `SSH_DB_ALIAS`，远端有 PostgreSQL 工具和非交互 sudo 权限；它们沿用示例数据库名 `heart_followup_v2`，用于其他名称前需自行调整。源码发布、日常部署和备份操作应各自核对目标，不能把私有运行文件上传 GitHub。
