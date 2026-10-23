# Third-party components

The repository's MIT license covers original application code. Dependencies and downloaded model files keep their own licenses; no dependency source, model weights, pretrained voices, or patient datasets are bundled.

| Component | Upstream | License / usage |
|---|---|---|
| Vue | https://github.com/vuejs/core | MIT |
| Element Plus | https://github.com/element-plus/element-plus | MIT |
| Fastify | https://github.com/fastify/fastify | MIT |
| PostgreSQL | https://www.postgresql.org/about/licence/ | PostgreSQL License |
| SenseVoiceSmall / int8 ONNX conversion | See `speech/MODEL_NOTICE.md` | FunASR Model Open Source License Agreement v1.1; retain attribution and model name |
| sherpa-onnx | https://github.com/k2-fsa/sherpa-onnx | Apache-2.0 |
| Matcha Chinese voice / Vocos model | See `speech/MODEL_NOTICE.md` | Model repositories declare Apache-2.0; retain their notices |

Use `package-lock.json`, Python requirements and the installed packages' own metadata for the full dependency list and applicable notices. When distributing model weights, obtain them separately and retain the upstream license and attribution. Cloud service APIs and accounts are subject to the provider's own terms.
