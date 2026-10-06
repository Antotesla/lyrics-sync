# Modello incluso

`Xenova/whisper-base` (Whisper di OpenAI, licenza MIT) convertito in ONNX quantizzato q8 per Transformers.js.
Copia presa dal pacchetto npm `sts-whisper-base` 1.0.0 (licenza Apache-2.0), che ripubblica i file di
https://huggingface.co/Xenova/whisper-base.

È ospitato qui perché l'app funzioni anche quando Hugging Face rifiuta il download (errore 403).
Anche `Xenova/whisper-small` (pacchetto npm `sts-whisper-small` 1.0.0, Apache-2.0) è incluso:
il decoder (157 MB) supera il limite di 100 MB di GitHub, quindi è diviso in
`decoder_model_merged_quantized.onnx.part1` e `.part2`; il worker (`js/worker.js`) li riunisce
in streaming durante il download. Per rigenerare le parti: `split -n 2` sul file originale
(la concatenazione deve essere identica byte per byte).
