# Caption model options

Checked September 8, 2026 against official OpenAI documentation. These are published API options, not a confirmation of this account's access or measured quality on Sakura calls. The transcription default has been migrated to `gpt-transcribe`; no live API quality or latency evaluation has been run.

## Transcription

Prices below are published estimates per minute of submitted audio, not per minute of wall-clock call time. Sakura uploads speech chunks, including their captured silence/pre-roll; each participant submits their own audio. Retranscribing a chunk can add cost. Text translation is billed separately.

| Model | USD/minute | USD/60 minutes of submitted audio | Fit |
| --- | ---: | ---: | --- |
| `gpt-4o-transcribe` (previous default) | 0.006 | 0.36 | Legacy override; shuts down February 26, 2027. |
| `gpt-4o-mini-transcribe` | 0.003 | 0.18 | Half the previous default's estimated transcription cost, but has the same retirement date. |
| `gpt-transcribe` (current default) | 0.0045 | 0.27 | Default for bounded audio/file requests; 25% below the previous default's estimate. |
| `gpt-live-transcribe` | 0.017 | 1.02 | Streaming live transcript deltas with tunable latency; requires a realtime integration. |
| `gpt-realtime-translate` | 0.034 | 2.04 | Dedicated streaming speech-to-speech translation with transcript deltas; a different product/integration choice. |

Sources: [pricing](https://developers.openai.com/api/docs/pricing#transcription-and-speech), [retirement schedule](https://developers.openai.com/api/docs/deprecations#2026-08-26-transcription-models), [file transcription](https://developers.openai.com/api/docs/guides/speech-to-text), [live transcription model](https://developers.openai.com/api/docs/models/gpt-live-transcribe), [realtime translation model](https://developers.openai.com/api/docs/models/gpt-realtime-translate).

Migration: `gpt-transcribe` is now the default for the existing chunked pipeline. Requests send `languages: [selectedLanguage]` instead of singular `language`, preserve existing prompts and script validation, and retain provider deadlines and cancellation. Older-model environment overrides retain the legacy language field. The installed SDK forwards the new multipart field without a dependency upgrade. Existing installations with an explicit `TRANSCRIPTION_MODEL` override must update it to use the new model.

Published comparisons favor the new model: [Artificial Analysis](https://artificialanalysis.ai/speech-to-text/non-streaming) reports 3.3% versus 4.0% WER; [Sauti](https://wisprs.co/voice/openai/gpt-transcribe) reports 11.8% versus 14.7%, with overlapping confidence intervals. These results do not establish Japanese accuracy or latency on Sakura's short caption segments. English/Japanese, short reactions, names, code-switching, and background noise remain useful live evaluation cases.

If partial captions while someone is still speaking are the priority, evaluate `gpt-live-transcribe` separately. It costs more per submitted audio minute and needs an ongoing session, incremental caption updates, cancellation, and reconnect handling. The AudioWorklet migration itself does not create a realtime provider stream.

## Text translation

Standard uncached input/output prices in USD per million tokens for short contexts:

| Model | Input | Output | Assessment for Sakura |
| --- | ---: | ---: | --- |
| `gpt-4o-mini` (current default) | 0.15 | 0.60 | Retain as the low-cost baseline. |
| `gpt-5.6-luna` | 0.20 | 1.20 | Current cost-focused GPT-5.6 option; more expensive than the baseline, worth evaluating for quality. Supports reasoning effort `none`. |
| `gpt-5.4-nano` | 0.20 | 1.25 | No price advantage over Luna at these rates. |
| `gpt-5.4-mini` | 0.75 | 4.50 | More expensive; only justified by demonstrated translation quality gains. |
| `gpt-4.1-nano` | 0.10 | 0.40 | Cheaper, but retires October 23, 2026; avoid a new migration to it. |
| `gpt-5-nano` | 0.05 | 0.40 | Cheaper published rates, but the original snapshot retires December 11, 2026; not a durable new default. |

Sources: [standard pricing](https://developers.openai.com/api/docs/pricing), [Luna capabilities](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [deprecations](https://developers.openai.com/api/docs/deprecations).

Recommendation: keep `gpt-4o-mini` until a small language-pair comparison demonstrates that Luna improves meaning, politeness, names, or conversational tone enough to justify its cost. Newer does not automatically mean cheaper or better for this specific task. Reasoning models can require different request parameters from the current `temperature: 0.2` Chat Completions call, so a switch should include request compatibility checks and latency measurement.

The migration changes the transcription default and request language hints while preserving translation configuration, provider deadlines, cancellation, and deduplication per target language. It does not establish live model latency, quality, account eligibility, or actual billed savings.
