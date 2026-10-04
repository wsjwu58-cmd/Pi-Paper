# Bundled provider icon provenance

Desktop provider and model pickers use these vendor-hosted assets from local files. The desktop component does not fetch brand assets at runtime. Assets were collected on 2026-10-03 and are kept as supplied, except ByteDance's embedded site icon, which was extracted byte-for-byte from the official homepage's `data:image/vnd.microsoft.icon` favicon URI.

| Local asset | Displayed for | Official source |
| --- | --- | --- |
| `anthropic.ico` | Anthropic | [Anthropic favicon](https://www.anthropic.com/favicon.ico) |
| `openai.svg` | OpenAI | [OpenAI design guidelines](https://openai.com/brand/) → official [2025 logo bundle](https://cdn.openai.com/brand/OpenAI-Logos-2025.zip); black monoblossom SVG |
| `google.ico` | Google / Google AI Studio | [Google favicon](https://www.google.com/favicon.ico) |
| `deepseek.ico` | DeepSeek | [DeepSeek favicon](https://www.deepseek.com/favicon.ico) |
| `xai.ico` | xAI | [xAI favicon](https://x.ai/favicon.ico); see [xAI brand guidelines](https://x.ai/legal/brand-guidelines) |
| `minimax.ico` | MiniMax | [MiniMax favicon](https://www.minimax.io/favicon.ico) |
| `elevenlabs.svg` | ElevenLabs | [ElevenLabs brand page](https://elevenlabs.io/brand), “ElevenLabs Symbol (SVG)” download |
| `fish-audio.ico` | Fish Audio | [Fish Audio favicon](https://fish.audio/favicon.ico) |
| `bytedance.png` | ByteDance / Volcano Engine brands | Official [ByteDance homepage](https://www.bytedance.com/), embedded favicon data URI |
| `alibaba-cloud.ico` | Alibaba Cloud / Alibaba video models | [Alibaba Cloud favicon](https://www.alibabacloud.com/favicon.ico) |
| `agnes.png` | Agnes | [Agnes official site asset](https://agnes-ai.com/images/biglogo.png) |
| `kling.png` | Kling | Official [Kling homepage](https://klingai.com) apple-touch-icon [80px asset](https://s16-kling.klingai.com/kos/s101/nlav112918/kling-homepage-aio/logo-80x80.png) |
| `vidu.svg` | Vidu | Official [Vidu homepage](https://www.vidu.com) favicon [SVG](https://www.vidu.com/logo.svg) |
| `pixverse.svg` | PixVerse | Official [PixVerse homepage](https://pixverse.ai) favicon [SVG](https://cdn.pixverse.ai/media/pixverse/favicon.svg) |
| `byteplus.png` | BytePlus | Official [BytePlus homepage](https://www.byteplus.com/en) favicon [PNG](https://sf-bpcms.bytepluscdn.com/obj/byteplus-public-aiso/portal/assets/favicon.png) |
| `moonshot.ico` | Moonshot AI | Official [Moonshot homepage](https://www.moonshot.ai/) favicon [ICO](https://statics.kimi.ai/moonshot-ai/favicon.ico) |
| `kimi.ico` | Kimi family | Official [Kimi API platform](https://platform.kimi.ai/) favicon [ICO](https://platform.kimi.ai/favicon.ico?v=3) |
| `qwen.png` | Qwen family | Official [Qwen Chat](https://chat.qwen.ai/) favicon [PNG](https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.12/favicon.png) |
| `happyhorse.png` | HappyHorse family | Official [HappyHorse homepage](https://www.happyhorse.com/) favicon [PNG](https://img.alicdn.com/imgextra/i1/O1CN01HtmeRD1ubFJYSMwQf_!!6000000006055-2-tps-160-160.png) |

The Alibaba asset is specifically the Alibaba Cloud site icon, not the Alibaba Group logo. Alibaba Group's [media resource page](https://home.alibabagroup.com/en-US/resource-logos) limits its group-logo assets to editorial use by accredited media, so none of those group assets are bundled here. Provider group icons use the configured vendor; separately supplied Qwen/Kimi/HappyHorse marks are available when the caller identifies a model family. Midjourney's official sites returned 403 for favicon retrieval, so it keeps the desktop symbol fallback.

These marks identify the configured provider in a compact settings/picker UI. They do not imply sponsorship or endorsement. OpenAI and xAI explicitly require accurate reference and prohibit implied endorsement; their marks remain unmodified. OpenAI's Blossom mark is used only as a small provider icon, not as this application's primary branding.

SHA-256 checksums for the bundled files:

```text
byteplus.png       64FC512A00A7E955B1FC678CC72485AABA3AF7A7FA5D915AACCD79DAA8474B76
moonshot.ico       B963E8D74A9A4F6986FEE2662E333AE4B4379F0553C8BF9EEE50D40A3077014F
kimi.ico           DF91C1ECF1D4894CF05845CDCE44549ED3CCCA3478B97A70972D1BC82AC4F2D1
qwen.png           CD9390BC4209C319121D111F3A1F535B3C7DD909B8F860D41ACC9744138D58DF
happyhorse.png     EEA32DCBEB033184D544FC26BD8EE49E5DC4FEB81FF16EAA805249501382DD9C
kling.png          3EE6EE1D4B1012FB04F0729FC47D340AC712AC155DA9D97B0AF966EF11B34CB7
vidu.svg           52DEF4BE8D299CCA673B28025B43AFC75D362E64F0E6056A857F6AB46B7ACE92
pixverse.svg       D9E42B3BA2518D299A097963FD4D27A92A1DB838B7540D77EC29246751EAACF0
agnes.png          7176E9463992C3A43387019B43AA69BF9DEADAD144BFCEC97510107A49B886F9
alibaba-cloud.ico  12A8E74153C9331DFB091E086A88A20F8B417399D86ADF5D18202B095E4D15B5
anthropic.ico      45FA55283B0671B71451D4E067932E3D4AE57EEB7B59582C4C3C1AB21558B0A4
bytedance.png      EDFCD80DB6AD4A4303BD301161376FA14805208C69C72CF92A2AA50F72BE9E5E
deepseek.ico       30A4420E6E4DCB17FD7DE560C5004346C2BC8CD971D2D5F5EE15326603E51321
elevenlabs.svg     84041B5EE800DD3CF5A4F731CDA268BDAF5804577C2EBA0F60E3AEBD18EDEFB9
fish-audio.ico     C34D658B0DA36604F0E5C117A7D977E06C0F75825A6B7C7F3EDE202C0FFDEC70
google.ico         6DA5620880159634213E197FAFCA1DDE0272153BE3E4590818533FAB8D040770
minimax.ico        43CE4C9B9E627B391A116CD5DA09E4C062D9C4E3D585509C65A4A3D16F386256
openai.svg         7BE72F1FEA831D3BA81A545CEE79B7E0AE69449D5D7837C9571CCBFB4AA1E00B
xai.ico            FB0AD1C3708C11CD6C569608F4FC14FD5D51A5B29EB9309CF83916D40D0B6852
```
