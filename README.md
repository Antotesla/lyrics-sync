# Lyrics Sync

Web app gratuita che trascrive una canzone e restituisce il testo **riga per riga con il tempo di inizio**:

```
(0:03) Prima riga cantata
(0:07) Seconda riga cantata
```

Tutto gira **nel browser** (Whisper tramite [Transformers.js](https://github.com/huggingface/transformers.js)): nessun server, nessun costo, i file non lasciano il dispositivo.

## Funzioni

- Upload di audio e video supportati dal browser (mp3, wav, m4a, aac, ogg, mp4, mov…).
- Modelli: **Automatico** (base se c'è il testo, small altrimenti), **Preciso** (whisper-small, ~250 MB), **Veloce** (whisper-base, ~80 MB). Il download avviene solo la prima volta, poi resta in cache.
- **Testo noto (consigliato)**: se incolli il testo (anche con i tempi già scritti, che vengono ignorati) — o se l'mp3 lo contiene già nei metadati, come i file di Suno — l'app usa le tue parole esatte e calcola solo i tempi. È la modalità più affidabile.
- Editor: ascolto da ogni riga, modifica di tempo e testo, ⏱ per fissare l'inizio al punto di riproduzione, unione ed eliminazione righe. Le righe incerte sono evidenziate.
- **Anteprima karaoke** (stile video per bambini): la riga corrente si illumina parola per parola, le righe successive scorrono sotto e una pallina rimbalza sulle parole cantate. Pulsante ⛶ per lo schermo intero.
- **Testo sopra un video esistente**: se carichi un video, il karaoke viene disegnato sopra (in basso, in alto o al centro). Per restare leggibile su qualsiasi colore usa una fascia scura semitrasparente (regolabile) oppure solo contorno e ombra; righe successive, dimensione e colori sono impostabili in "Aspetto del testo" e vengono ricordati. Il disegno (`js/karaoke.js`) dipende solo dal tempo, così servirà anche per esportare il video.
- Export: TXT nel formato `(m:ss) testo`, **LRC** (testi sincronizzati), **SRT** (sottotitoli), **ASS karaoke** (parole che si colorano, con le stesse impostazioni di posizione, fascia e colore — la pallina c'è solo nell'anteprima; si apre con VLC o Aegisub, o si incide nel video con `ffmpeg -i video.mp4 -vf ass=canzone.ass out.mp4`).

## Precisione e velocità misurate

Canzone di prova di 2:05 (37 righe) con tempi scritti a mano come riferimento; Chromium, 4 core, nessuna GPU:

| Modalità | Modello | Tempo | Righe con tempo esatto (al secondo) | Entro 1 s |
| --- | --- | --- | --- | --- |
| Con testo | base | ~50 s | 30/37 | 37/37 |
| Con testo | small | ~2 min 30 s | 29/37 | 37/37 |
| Automatica | small | ~2 min 10 s | inizi riga trovati: 33/37 | — |
| Automatica | base | ~50 s | inizi riga trovati: 26/37 | — |

Con il testo il modello base basta: per questo "Automatico" lo sceglie quando il testo c'è.

**iPhone/iPad: non funziona.** Durante la trascrizione il motore wasm arriva a ~850 MB (misurato) e Safari su iPhone chiude la pagina dopo pochi secondi di ascolto. Il modello tiny usa meno memoria ma sbaglia i tempi fino a 30 s; ridurre le ottimizzazioni di ONNX Runtime abbassa il picco solo a ~650 MB e rompe i tempi. Su iOS l'app mostra un avviso.

## Limiti

- Il modello **Veloce (base)** è incluso nel sito (cartella `models/`, ~77 MB): funziona anche se Hugging Face blocca il download. Il modello **Preciso (small)** viene ancora scaricato da Hugging Face.

- Il riconoscimento del cantato sopra la musica non è perfetto: senza testo fornito aspettati parole sbagliate (es. nomi propri, parole stirate). I **tempi delle righe** sono in genere precisi entro ~0,5 s; la precisione delle **singole parole** non è ancora stata misurata.
- Formati video come mkv/avi dipendono dal browser.

## Sviluppo

App statica, nessuna build. Per provarla in locale:

```
npm start        # serve la cartella su http://localhost:8080
npm test         # test unitari (Node 22)
```

Struttura:

| File | Ruolo |
| --- | --- |
| `js/worker.js` | Whisper in un Web Worker, trascrizione a finestre scorrevoli |
| `js/lines.js` | parole → righe; allineamento con un testo noto |
| `js/audio.js` | decodifica e conversione a 16 kHz mono |
| `js/id3.js` | lettura del testo dai metadati mp3 |
| `js/formats.js` | export TXT / LRC / SRT / ASS |
| `js/karaoke.js` | disegno del karaoke su canvas (righe, colore, pallina) |

## Pubblicazione gratuita (GitHub Pages)

Settings → Pages → Source: *Deploy from a branch* → `main` / root. L'app sarà su `https://<utente>.github.io/lyrics-sync/`.
